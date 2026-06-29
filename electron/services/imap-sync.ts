import { ImapFlow } from 'imapflow'
import { simpleParser, type Attachment } from 'mailparser'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { Provider, FolderType, SyncStatus } from '../../shared/types'
import { getAttachmentsDir } from '../db'
import {
  getAccountTokens,
  getManualCredentials,
  updateAccountTokens,
  upsertFolder,
  upsertMessage,
  updateFolderUnread,
  addAttachment,
  listAccounts,
  getFolderMaxUid,
  getFolderUidValidity,
  updateFolderSyncState,
  clearFolderMessages,
  hasMessageUid,
  type TokenData
} from './db-service'
import { getLastSyncAt, setLastSyncAt } from './preferences-service'
import { imapFlowSecure } from './account-credentials'
import { refreshGoogleToken, resolveGoogleAccessToken, formatGmailAuthError } from './oauth-google'
import { refreshMicrosoftToken } from './oauth-microsoft'
import {
  estimatePop3NewMessageCount,
  syncPop3Account,
  deletePop3MessageOnServer
} from './pop3-sync'

const POLL_INTERVAL_MS = 20_000

const PROVIDER_CONFIG: Record<
  'gmail' | 'o365',
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

export function initSyncFromPersistence(): void {
  syncStatus = {
    ...syncStatus,
    lastSyncAt: getLastSyncAt()
  }
}

let statusListeners: ((s: SyncStatusState) => void)[] = []
let pollInterval: ReturnType<typeof setInterval> | null = null
let syncLock = false

export type SyncProgressHandler = () => void

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
  if (patch.lastSyncAt !== undefined) {
    setLastSyncAt(patch.lastSyncAt)
  }
  statusListeners.forEach((l) => l({ ...syncStatus }))
}

function incrementSyncProgress(by = 1): void {
  setSyncStatus({ syncCurrent: syncStatus.syncCurrent + by })
}

const SYNC_BATCH_SIZE = 200

function estimateNewMessagesInFolder(maxLocalUid: number | null, uidNext: number): number {
  const highestUid = Math.max(0, uidNext - 1)
  if (maxLocalUid == null) {
    return Math.min(SYNC_BATCH_SIZE, highestUid)
  }
  if (uidNext <= maxLocalUid + 1) return 0
  return highestUid - maxLocalUid
}

async function countNewMessagesForAccount(
  accountId: string,
  provider: Provider
): Promise<number> {
  if (provider === 'pop3') {
    return estimatePop3NewMessageCount(accountId)
  }

  const client = await createImapClient(accountId, provider)
  let total = 0

  try {
    const mailboxes = await client.list()
    for (const mb of mailboxes) {
      if (mb.flags?.has('\\Noselect')) continue
      const folder = upsertFolder(
        accountId,
        mb.path,
        mb.name,
        detectFolderType(mb.name, mb.specialUse)
      )
      const status = await client.status(mb.path, { uidNext: true, uidValidity: true })
      total += estimateNewMessagesInFolder(getFolderMaxUid(folder.id), status.uidNext ?? 1)
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

export async function createImapClient(
  accountId: string,
  provider: Provider
): Promise<ImapFlow> {
  if (provider === 'pop3') {
    throw new Error('POP3 accounts do not use IMAP')
  }

  const manual = provider === 'imap' ? getManualCredentials(accountId) : null

  if (manual) {
    const client = new ImapFlow({
      host: manual.incoming.host,
      port: manual.incoming.port,
      secure: imapFlowSecure(manual.incoming.security),
      auth: {
        user: manual.username,
        pass: manual.password
      },
      logger: false
    })
    await client.connect()
    return client
  }

  const stored = getAccountTokens(accountId)
  if (!stored) throw new Error('Account tokens not found')

  let email = stored.email
  let accessToken = stored.accessToken

  try {
    if (provider === 'gmail') {
      const resolved = await resolveGoogleAccessToken(accountId, stored)
      accessToken = resolved.accessToken
      email = resolved.tokenData.email
    } else {
      const tokens = await ensureFreshToken(accountId, provider, stored)
      accessToken = tokens.accessToken
      email = tokens.email
    }
  } catch (err) {
    if (provider === 'gmail') {
      throw formatGmailAuthError(err, email)
    }
    throw err
  }

  const config = PROVIDER_CONFIG[provider as 'gmail' | 'o365']

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: {
      user: email,
      accessToken
    },
    logger: false
  })

  try {
    await client.connect()
  } catch (err) {
    if (provider === 'gmail') {
      throw formatGmailAuthError(err, email)
    }
    throw err
  }

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

async function getRecentMessageUids(client: ImapFlow, batchSize: number): Promise<number[]> {
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
let onNewMailArrived: ((count: number) => void) | null = null

export function setOnFolderSynced(callback: (() => void) | null): void {
  onFolderSynced = callback
}

export function setOnNewMailArrived(callback: ((count: number) => void) | null): void {
  onNewMailArrived = callback
}

async function resolveUidsToFetch(
  client: ImapFlow,
  folderId: string,
  maxLocalUid: number | null,
  uidNext: number
): Promise<number[]> {
  if (maxLocalUid != null && uidNext <= maxLocalUid + 1) {
    return []
  }

  let candidates: number[]
  if (maxLocalUid == null) {
    candidates = await getRecentMessageUids(client, SYNC_BATCH_SIZE)
  } else {
    candidates = (await client.search({ uid: `${maxLocalUid + 1}:*` }, { uid: true })) ?? []
  }

  return candidates.filter((uid) => !hasMessageUid(folderId, uid))
}

export function findInboxMailbox<
  T extends { name: string; path: string; specialUse?: string[]; flags?: Set<string> }
>(mailboxes: T[]): T | undefined {
  return mailboxes.find(
    (mb) =>
      !mb.flags?.has('\\Noselect') &&
      (mb.path === 'INBOX' ||
        mb.name === 'INBOX' ||
        mb.specialUse?.includes('\\Inbox'))
  )
}

export function detectFolderType(name: string, specialUse?: string[]): FolderType {
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

async function fetchMessagesByUid(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  uids: number[],
  onProgress?: SyncProgressHandler
): Promise<{ newCount: number; maxUid: number | null }> {
  if (uids.length === 0) return { newCount: 0, maxUid: null }

  let newCount = 0
  let maxUid: number | null = null

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

    maxUid = maxUid == null ? msg.uid : Math.max(maxUid, msg.uid)

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

    const { id, isNew } = upsertMessage({
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

    if (!isNew) continue

    if (parsed.attachments?.length) {
      await saveAttachments(id, msg.uid, parsed.attachments)
    }

    newCount++
    onProgress?.()
  }

  return { newCount, maxUid }
}

export async function syncFolder(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  imapPath: string,
  onProgress?: SyncProgressHandler
): Promise<number> {
  const status = await client.status(imapPath, {
    uidNext: true,
    unseen: true,
    uidValidity: true
  })
  updateFolderUnread(folderId, status.unseen ?? 0)

  const storedValidity = getFolderUidValidity(folderId)
  const serverValidity = status.uidValidity ?? null
  if (
    storedValidity != null &&
    serverValidity != null &&
    storedValidity !== serverValidity
  ) {
    clearFolderMessages(folderId)
  }

  let maxLocalUid = getFolderMaxUid(folderId)
  const uidNext = status.uidNext ?? 1

  if (maxLocalUid != null && uidNext <= maxLocalUid + 1) {
    updateFolderSyncState(folderId, {
      uidValidity: serverValidity,
      lastSyncAt: Date.now()
    })
    return 0
  }

  const lock = await client.getMailboxLock(imapPath)
  try {
    const uids = await resolveUidsToFetch(client, folderId, maxLocalUid, uidNext)
    const { newCount, maxUid } = await fetchMessagesByUid(
      client,
      accountId,
      folderId,
      uids,
      onProgress
    )

    const highestSyncedUid = Math.max(maxLocalUid ?? 0, maxUid ?? 0)
    updateFolderSyncState(folderId, {
      uidValidity: serverValidity,
      highestSyncedUid,
      lastSyncAt: Date.now(),
      initialSyncComplete: highestSyncedUid > 0
    })

    return newCount
  } finally {
    lock.release()
  }
}

export async function syncAccount(
  accountId: string,
  provider: Provider,
  options: { onProgress?: SyncProgressHandler; silent?: boolean } = {}
): Promise<number> {
  if (syncLock) return 0
  syncLock = true

  try {
    if (provider === 'pop3') {
      const newCount = await syncPop3Account(accountId, options.onProgress ?? incrementSyncProgress)
      if (newCount > 0) onFolderSynced?.()
      return newCount
    }

    const client = await createImapClient(accountId, provider)
    let newCount = 0

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

        const fetched = await syncFolder(
          client,
          accountId,
          folderId,
          mb.path,
          options.onProgress
        )
        if (fetched > 0) {
          newCount += fetched
          onFolderSynced?.()
        }
      }
    } finally {
      await client.logout()
    }

    return newCount
  } finally {
    syncLock = false
  }
}

function accountSyncError(email: string, err: unknown): string {
  return err instanceof Error ? err.message : `Sync failed for ${email}`
}

export async function refreshAccount(accountId: string, provider: Provider): Promise<void> {
  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: 0
  })

  try {
    const total = await countNewMessagesForAccount(accountId, provider)
    setSyncStatus({ syncTotal: Math.max(total, 1) })

    const fetched = await syncAccount(accountId, provider, {
      onProgress: incrementSyncProgress
    })

    setSyncStatus({
      syncing: false,
      lastSyncAt: Date.now(),
      error: null,
      syncCurrent: fetched,
      syncTotal: Math.max(fetched, total, 1)
    })
  } catch (err) {
    const message = accountSyncError(
      getAccountTokens(accountId)?.email ?? accountId,
      err
    )
    setSyncStatus({ syncing: false, error: message })
    throw err instanceof Error ? err : new Error(message)
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

  const accounts = listAccounts()
  const errors: string[] = []
  let estimatedTotal = 0

  for (const account of accounts) {
    try {
      estimatedTotal += await countNewMessagesForAccount(account.id, account.provider)
    } catch (err) {
      errors.push(accountSyncError(account.email, err))
    }
  }

  setSyncStatus({ syncTotal: Math.max(estimatedTotal, 1) })

  let fetchedTotal = 0
  for (const account of accounts) {
    try {
      fetchedTotal += await syncAccount(account.id, account.provider, {
        onProgress: incrementSyncProgress
      })
    } catch (err) {
      errors.push(accountSyncError(account.email, err))
    }
  }

  setSyncStatus({
    syncing: false,
    lastSyncAt: Date.now(),
    error: errors.length ? errors.join('\n\n') : null,
    syncCurrent: fetchedTotal,
    syncTotal: Math.max(fetchedTotal, estimatedTotal, 1)
  })

  if (errors.length === accounts.length && accounts.length > 0) {
    throw new Error(errors.join('\n\n'))
  }
}

export async function pollForNewMessages(): Promise<void> {
  if (syncStatus.syncing) return

  const accounts = listAccounts()
  if (accounts.length === 0) return

  let estimatedTotal = 0
  for (const account of accounts) {
    try {
      estimatedTotal += await countNewMessagesForAccount(account.id, account.provider)
    } catch {
      // polling should not surface transient errors in the UI
    }
  }

  if (estimatedTotal === 0) {
    setSyncStatus({ lastSyncAt: Date.now() })
    return
  }

  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: estimatedTotal
  })

  let fetchedTotal = 0
  for (const account of accounts) {
    try {
      fetchedTotal += await syncAccount(account.id, account.provider, {
        onProgress: incrementSyncProgress,
        silent: true
      })
    } catch {
      // keep polling on the next interval
    }
  }

  setSyncStatus({
    syncing: false,
    lastSyncAt: Date.now(),
    syncCurrent: fetchedTotal,
    syncTotal: Math.max(fetchedTotal, estimatedTotal)
  })

  if (fetchedTotal > 0) {
    onFolderSynced?.()
    onNewMailArrived?.(fetchedTotal)
  }
}

export function startBackgroundSync(intervalMs = POLL_INTERVAL_MS): void {
  if (pollInterval) return
  pollInterval = setInterval(() => {
    pollForNewMessages().catch(() => {})
  }, intervalMs)
}

export function stopBackgroundSync(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
}

export async function markMessageReadOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number,
  isRead: boolean
): Promise<void> {
  if (provider === 'pop3') return

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

export async function toggleMessageStarredOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number,
  isStarred: boolean
): Promise<void> {
  if (provider === 'pop3') return

  const client = await createImapClient(accountId, provider)
  try {
    const lock = await client.getMailboxLock(folderPath)
    try {
      if (isStarred) {
        await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true })
      } else {
        await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true })
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
  if (provider === 'pop3') {
    await deletePop3MessageOnServer(accountId, uid)
    return
  }

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
  if (provider === 'pop3') {
    throw new Error('Moving messages is not supported for POP3 accounts')
  }

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
  if (provider === 'pop3') return

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

export function getAccountSmtpConfig(accountId: string, provider: Provider) {
  if (provider === 'imap' || provider === 'pop3') {
    const manual = getManualCredentials(accountId)
    if (!manual) throw new Error('SMTP settings not found')
    return manual.outgoing
  }
  return PROVIDER_CONFIG[provider as 'gmail' | 'o365'].smtp
}

export function getProviderSmtpConfig(provider: Provider) {
  if (provider === 'imap' || provider === 'pop3') {
    throw new Error('Use getAccountSmtpConfig for manual accounts')
  }
  return PROVIDER_CONFIG[provider].smtp
}
