import { ImapFlow } from 'imapflow'
import { simpleParser, type Attachment } from 'mailparser'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { Provider, FolderType, SyncStatus } from '../../shared/types'
import { getAttachmentsDir } from '../db'
import {
  getAccountTokens,
  updateAccountTokens,
  upsertFolder,
  upsertMessage,
  updateFolderUnread,
  addAttachment,
  listAccounts,
  type TokenData
} from './db-service'
import { refreshGoogleToken } from './oauth-google'
import { refreshMicrosoftToken } from './oauth-microsoft'

const PROVIDER_CONFIG: Record<
  Provider,
  { imap: { host: string; port: number }; smtp: { host: string; port: number } }
> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 587 }
  },
  o365: {
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp.office365.com', port: 587 }
  }
}

const SPECIAL_USE_MAP: Record<string, FolderType> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk'
}

const FOLDER_NAME_MAP: Record<string, FolderType> = {
  INBOX: 'inbox',
  'Sent Mail': 'sent',
  'Sent Items': 'sent',
  Sent: 'sent',
  Drafts: 'drafts',
  Trash: 'trash',
  Deleted: 'trash',
  'Deleted Items': 'trash',
  Junk: 'junk',
  Spam: 'junk'
}

export type SyncStatusState = SyncStatus

let syncStatus: SyncStatusState = {
  syncing: false,
  lastSyncAt: null,
  error: null,
  syncCurrent: 0,
  syncTotal: 0
}

let statusListeners: ((s: SyncStatusState) => void)[] = []
let syncInterval: ReturnType<typeof setInterval> | null = null

export function getSyncStatus(): SyncStatusState {
  return { ...syncStatus }
}

export function onSyncStatusChange(listener: (s: SyncStatusState) => void): () => void {
  statusListeners.push(listener)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener)
  }
}

function setSyncStatus(patch: Partial<SyncStatusState>): void {
  syncStatus = { ...syncStatus, ...patch }
  statusListeners.forEach((l) => l({ ...syncStatus }))
}

function incrementSyncProgress(by = 1): void {
  setSyncStatus({ syncCurrent: syncStatus.syncCurrent + by })
}

const SYNC_BATCH_SIZE = 200

function countMessagesInSyncRange(messageCount: number | undefined, uidNext: number): number {
  if (messageCount != null && messageCount > 0) {
    return Math.min(SYNC_BATCH_SIZE, messageCount)
  }
  return Math.min(SYNC_BATCH_SIZE, Math.max(0, uidNext - 1))
}

async function estimateAccountMessageCount(
  accountId: string,
  provider: Provider
): Promise<number> {
  const client = await createImapClient(accountId, provider)
  let total = 0

  try {
    const mailboxes = await client.list()
    for (const mb of mailboxes) {
      if (mb.flags?.has('\\Noselect')) continue
      const status = await client.status(mb.path, { uidNext: true, unseen: true, messages: true })
      total += countMessagesInSyncRange(status.messages, status.uidNext ?? 1)
    }
  } finally {
    await client.logout()
  }

  return total
}

async function ensureFreshToken(
  accountId: string,
  provider: Provider,
  tokens: TokenData
): Promise<TokenData> {
  const needsRefresh =
    !tokens.expiryDate || tokens.expiryDate < Date.now() + 120000

  if (!needsRefresh) return tokens

  let refreshed: TokenData
  if (provider === 'gmail' && tokens.refreshToken) {
    refreshed = await refreshGoogleToken(tokens)
  } else if (provider === 'o365') {
    refreshed = await refreshMicrosoftToken(tokens, tokens.email)
  } else {
    return tokens
  }

  updateAccountTokens(accountId, refreshed)
  return refreshed
}

async function createImapClient(
  accountId: string,
  provider: Provider
): Promise<ImapFlow> {
  let tokens = getAccountTokens(accountId)
  if (!tokens) throw new Error('Account tokens not found')

  tokens = await ensureFreshToken(accountId, provider, tokens)
  const config = PROVIDER_CONFIG[provider]

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: {
      user: tokens.email,
      accessToken: tokens.accessToken
    },
    logger: false
  })

  await client.connect()
  return client
}

function folderSyncRank(mb: { name: string; path: string; specialUse?: string[] }): number {
  const priority = ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk']
  const specialIdx = priority.findIndex((p) => mb.specialUse?.includes(p))
  if (specialIdx !== -1) return specialIdx

  if (mb.path === 'INBOX' || mb.name === 'INBOX') return 0

  const type = detectFolderType(mb.name, mb.specialUse)
  const typeRank: Record<FolderType, number> = {
    inbox: 0,
    sent: 1,
    drafts: 2,
    trash: 3,
    junk: 4,
    custom: 100
  }
  return typeRank[type]
}

function sortMailboxesForSync<
  T extends { name: string; path: string; specialUse?: string[]; flags?: Set<string> }
>(mailboxes: T[]): T[] {
  return [...mailboxes].sort((a, b) => {
    const diff = folderSyncRank(a) - folderSyncRank(b)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name)
  })
}

async function getMessageUidsToSync(client: ImapFlow, batchSize: number): Promise<number[]> {
  try {
    const sorted = await client.sort(['REVERSE DATE'], ['ALL'], { uid: true })
    if (sorted?.length) {
      return sorted.slice(0, batchSize)
    }
  } catch {
    // SORT not supported — fall back to SEARCH
  }

  const all = await client.search({ all: true }, { uid: true })
  if (!all?.length) return []
  return all.length > batchSize ? all.slice(-batchSize) : all
}

let onFolderSynced: (() => void) | null = null

export function setOnFolderSynced(callback: (() => void) | null): void {
  onFolderSynced = callback
}

function detectFolderType(name: string, specialUse?: string[]): FolderType {
  if (specialUse) {
    for (const flag of specialUse) {
      const mapped = SPECIAL_USE_MAP[flag]
      if (mapped) return mapped
    }
  }
  return FOLDER_NAME_MAP[name] ?? 'custom'
}

function formatAddress(addr: { address?: string; name?: string } | undefined): string {
  if (!addr) return ''
  if (addr.name) return `${addr.name} <${addr.address}>`
  return addr.address ?? ''
}

function formatAddressList(
  addrs: { address?: string; name?: string }[] | undefined
): string {
  if (!addrs?.length) return ''
  return addrs.map((a) => formatAddress(a)).join(', ')
}

function makeSnippet(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

async function saveAttachments(
  messageId: string,
  uid: number,
  parsedAttachments: Attachment[]
): Promise<void> {
  const dir = getAttachmentsDir()
  for (const att of parsedAttachments) {
    if (!att.content) continue
    const safeName = (att.filename ?? `attachment-${uid}`).replace(/[^\w.-]/g, '_')
    const path = join(dir, `${messageId}-${safeName}`)
    writeFileSync(path, att.content)
    addAttachment(
      messageId,
      att.filename ?? safeName,
      att.contentType ?? 'application/octet-stream',
      att.size ?? att.content.length,
      path
    )
  }
}

export async function syncAccount(accountId: string, provider: Provider): Promise<void> {
  const client = await createImapClient(accountId, provider)

  try {
    const mailboxes = await client.list()
    const folderMap: Record<string, string> = {}

    for (const mb of mailboxes) {
      if (mb.flags?.has('\\Noselect')) continue
      const type = detectFolderType(mb.name, mb.specialUse)
      const folder = upsertFolder(accountId, mb.path, mb.name, type)
      folderMap[mb.path] = folder.id
    }

    for (const mb of sortMailboxesForSync(mailboxes)) {
      if (mb.flags?.has('\\Noselect')) continue
      const folderId = folderMap[mb.path]
      if (!folderId) continue

      const lock = await client.getMailboxLock(mb.path)
      try {
        const status = await client.status(mb.path, {
          uidNext: true,
          unseen: true,
          messages: true
        })
        updateFolderUnread(folderId, status.unseen ?? 0)

        const uids = await getMessageUidsToSync(client, SYNC_BATCH_SIZE)
        if (uids.length === 0) continue

        for await (const msg of client.fetch(
          uids.join(','),
          {
            uid: true,
            envelope: true,
            flags: true,
            source: true
          },
          { uid: true }
        )) {
          if (!msg.source) continue

          const parsed = await simpleParser(msg.source)
          const from = formatAddress(parsed.from?.value[0])
          const to = formatAddressList(parsed.to?.value)
          const cc = formatAddressList(parsed.cc?.value)
          const subject = parsed.subject ?? '(No subject)'
          const bodyText = parsed.text ?? ''
          const bodyHtml = parsed.html ? String(parsed.html) : null
          const snippet = makeSnippet(bodyText || (parsed.textAsHtml ?? subject))
          const date = parsed.date?.getTime() ?? Date.now()
          const isRead = msg.flags?.has('\\Seen') ?? false
          const isStarred = msg.flags?.has('\\Flagged') ?? false
          const hasAttachments = (parsed.attachments?.length ?? 0) > 0

          const messageId = upsertMessage({
            folderId,
            accountId,
            uid: msg.uid,
            messageId: parsed.messageId,
            from,
            to,
            cc,
            subject,
            snippet,
            date,
            isRead,
            isStarred,
            hasAttachments,
            bodyHtml,
            bodyText
          })

          if (parsed.attachments?.length) {
            await saveAttachments(messageId, msg.uid, parsed.attachments)
          }

          incrementSyncProgress()
        }

        onFolderSynced?.()
      } finally {
        lock.release()
      }
    }
  } finally {
    await client.logout()
  }
}

export async function refreshAccount(accountId: string, provider: Provider): Promise<void> {
  if (syncStatus.syncing) return

  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: 0
  })

  try {
    const total = await estimateAccountMessageCount(accountId, provider)
    setSyncStatus({ syncTotal: total })
    await syncAccount(accountId, provider)
    setSyncStatus({
      syncing: false,
      lastSyncAt: Date.now(),
      error: null,
      syncCurrent: total,
      syncTotal: total
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSyncStatus({ syncing: false, error: message })
    throw err
  }
}

export async function refreshAllAccounts(): Promise<void> {
  if (syncStatus.syncing) return

  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: 0
  })

  try {
    const accounts = listAccounts()
    let total = 0
    for (const account of accounts) {
      total += await estimateAccountMessageCount(account.id, account.provider)
    }
    setSyncStatus({ syncTotal: total })

    for (const account of accounts) {
      await syncAccount(account.id, account.provider)
    }
    setSyncStatus({
      syncing: false,
      lastSyncAt: Date.now(),
      error: null,
      syncCurrent: total,
      syncTotal: total
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    setSyncStatus({ syncing: false, error: message })
    throw err
  }
}

export function startBackgroundSync(intervalMs = 60000): void {
  if (syncInterval) return
  syncInterval = setInterval(() => {
    refreshAllAccounts().catch(() => {})
  }, intervalMs)
}

export function stopBackgroundSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}

export async function markMessageReadOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number,
  isRead: boolean
): Promise<void> {
  const client = await createImapClient(accountId, provider)
  try {
    const lock = await client.getMailboxLock(folderPath)
    try {
      if (isRead) {
        await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true })
      } else {
        await client.messageFlagsRemove({ uid }, ['\\Seen'], { uid: true })
      }
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

export async function deleteMessageOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number
): Promise<void> {
  const client = await createImapClient(accountId, provider)
  try {
    const lock = await client.getMailboxLock(folderPath)
    try {
      await client.messageDelete({ uid }, { uid: true })
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

export async function moveMessageOnServer(
  accountId: string,
  provider: Provider,
  sourcePath: string,
  targetPath: string,
  uid: number
): Promise<void> {
  const client = await createImapClient(accountId, provider)
  try {
    const lock = await client.getMailboxLock(sourcePath)
    try {
      await client.messageMove({ uid }, targetPath, { uid: true })
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

export async function appendToSentFolder(
  accountId: string,
  provider: Provider,
  rawMessage: Buffer
): Promise<void> {
  const client = await createImapClient(accountId, provider)
  try {
    const mailboxes = await client.list()
    const sentMb = mailboxes.find(
      (mb) =>
        mb.specialUse?.includes('\\Sent') ||
        FOLDER_NAME_MAP[mb.name] === 'sent'
    )
    const path = sentMb?.path ?? 'Sent'
    await client.append(path, rawMessage, ['\\Seen'])
  } finally {
    await client.logout()
  }
}

export function getProviderSmtpConfig(provider: Provider) {
  return PROVIDER_CONFIG[provider].smtp
}
