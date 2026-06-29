import { writeFileSync } from 'fs'
import type { AccountInfo, Provider } from '../../shared/types'
import {
  clearFolderMessages,
  countMessages,
  getAccountById,
  getAccountStorageUsage,
  getFolderById,
  listAccounts,
  listFolders,
  markAllMessagesReadInFolder,
  pruneMessagesOutsideSyncWindow,
  updateAccountDisplayName,
  updateAccountSyncDays,
  upsertFolder
} from './db-service'
import { createImapClient, refreshAccount } from './imap-sync'

const PROVIDER_LABELS: Record<Provider, string> = {
  gmail: 'Gmail',
  o365: 'Microsoft 365',
  imap: 'IMAP',
  pop3: 'POP3'
}

function requireImapAccount(accountId: string) {
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account) throw new Error('Account not found')
  if (account.provider === 'pop3') {
    throw new Error('This action is not supported for POP3 accounts')
  }
  return account
}

function findAccountFolder(accountId: string, type: 'trash' | 'junk') {
  const folder = listFolders(accountId).find((f) => f.type === type)
  if (!folder) {
    throw new Error(type === 'trash' ? 'No trash folder found' : 'No junk folder found')
  }
  return folder
}

export function getAccountInfo(accountId: string): AccountInfo {
  const account = getAccountById(accountId)
  if (!account) throw new Error('Account not found')

  const folders = listFolders(accountId)
  let messageCount = 0
  for (const folder of folders) {
    messageCount += countMessages(folder.id)
  }

  const storage = getAccountStorageUsage(accountId)

  return {
    id: account.id,
    provider: account.provider,
    providerLabel: PROVIDER_LABELS[account.provider],
    email: account.email,
    displayName: account.displayName,
    createdAt: account.createdAt,
    folderCount: folders.length,
    messageCount,
    unreadCount: folders.reduce((sum, folder) => sum + folder.unreadCount, 0),
    syncDays: account.syncDays,
    localStorageBytes: storage.contentBytes + storage.attachmentBytes,
    attachmentCount: storage.attachmentCount,
    downloadedAttachmentCount: storage.downloadedAttachmentCount
  }
}

export function setAccountSyncDays(accountId: string, syncDays: number): Account {
  const account = updateAccountSyncDays(accountId, syncDays)
  pruneMessagesOutsideSyncWindow(accountId, syncDays)
  return account
}

export async function createMailbox(accountId: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Mailbox name is required')

  const account = requireImapAccount(accountId)
  const client = await createImapClient(account.id, account.provider)

  try {
    const mailboxes = await client.list()
    const inbox = mailboxes.find(
      (mb) =>
        !mb.flags?.has('\\Noselect') &&
        (mb.path === 'INBOX' || mb.name === 'INBOX' || mb.specialUse?.includes('\\Inbox'))
    )
    const parentPath = inbox?.path ?? 'INBOX'
    const separator = client.namespace?.personal?.[0]?.delimiter ?? '.'
    const imapPath = `${parentPath}${separator}${trimmed}`

    await client.mailboxCreate(imapPath)
    upsertFolder(accountId, imapPath, trimmed, 'custom')
  } finally {
    await client.logout()
  }
}

export async function exportMailboxToMbox(
  folderId: string,
  destinationPath: string
): Promise<number> {
  const folder = getFolderById(folderId)
  if (!folder) throw new Error('Folder not found')

  const account = listAccounts().find((a) => a.id === folder.accountId)
  if (!account) throw new Error('Account not found')
  if (account.provider === 'pop3') {
    throw new Error('Mailbox export is not supported for POP3 accounts')
  }

  const client = await createImapClient(account.id, account.provider)
  let exported = 0

  try {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      const messages = await client.fetchAll({ all: true }, { uid: true, source: true }, { uid: true })
      const parts: string[] = []

      for (const msg of messages) {
        if (!msg.source) continue
        const fromLine = `From MAILER-DAEMON ${new Date(msg.internalDate ?? Date.now()).toUTCString()}`
        parts.push(fromLine)
        parts.push(msg.source.toString('utf8'))
        if (!parts[parts.length - 1].endsWith('\n')) {
          parts.push('')
        }
        exported++
      }

      writeFileSync(destinationPath, parts.join('\n'), 'utf8')
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }

  return exported
}

export async function emptySpecialFolder(accountId: string, type: 'trash' | 'junk'): Promise<number> {
  const folder = findAccountFolder(accountId, type)
  const account = listAccounts().find((a) => a.id === folder.accountId)
  if (!account) throw new Error('Account not found')

  if (account.provider === 'pop3') {
    clearFolderMessages(folder.id)
    return 0
  }

  const client = await createImapClient(account.id, account.provider)
  try {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      const status = await client.status(folder.imapPath, { messages: true })
      const count = status.messages ?? 0
      if (count > 0) {
        await client.messageDelete({ all: true }, { uid: true })
      }
      clearFolderMessages(folder.id)
      return count
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

export async function markFolderAllRead(folderId: string): Promise<number> {
  const folder = getFolderById(folderId)
  if (!folder) throw new Error('Folder not found')

  const account = listAccounts().find((a) => a.id === folder.accountId)
  if (!account) throw new Error('Account not found')

  const marked = markAllMessagesReadInFolder(folderId)

  if (account.provider !== 'pop3') {
    const client = await createImapClient(account.id, account.provider)
    try {
      const lock = await client.getMailboxLock(folder.imapPath)
      try {
        await client.messageFlagsAdd({ seen: false }, ['\\Seen'], { uid: true })
      } finally {
        lock.release()
      }
    } finally {
      await client.logout()
    }
  }

  return marked
}

export async function syncAccountNow(accountId: string): Promise<void> {
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account) throw new Error('Account not found')
  await refreshAccount(account.id, account.provider)
}

export function editAccountDisplayName(accountId: string, displayName: string): void {
  const trimmed = displayName.trim()
  if (!trimmed) throw new Error('Display name is required')
  updateAccountDisplayName(accountId, trimmed)
}
