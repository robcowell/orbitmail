import type { Account, Folder, Provider } from './types'

const GMAIL_VIRTUAL_IMAP_PATHS = new Set([
  '[Gmail]/All Mail',
  '[Gmail]/Important',
  '[Gmail]/Starred',
  '[Gmail]/Snoozed'
])

export function isVirtualViewFolder(provider: Provider, imapPath: string): boolean {
  if (provider !== 'gmail') return false
  if (GMAIL_VIRTUAL_IMAP_PATHS.has(imapPath)) return true
  return /^\[Gmail\]\/(All Mail|Important|Starred|Snoozed)$/i.test(imapPath)
}

export function shouldShowFolderUnreadBadge(folder: Folder): boolean {
  return !folder.isVirtualView && folder.unreadCount > 0
}

export function accountUnreadCount(account: Account, folders: Folder[]): number {
  const accountFolders = folders.filter((folder) => folder.accountId === account.id)

  if (account.provider === 'gmail') {
    return accountFolders.find((folder) => folder.type === 'inbox')?.unreadCount ?? 0
  }

  const inbox = accountFolders.find((folder) => folder.type === 'inbox')
  if (inbox) return inbox.unreadCount

  return accountFolders
    .filter((folder) => !folder.isVirtualView && folder.type !== 'custom')
    .reduce((sum, folder) => sum + folder.unreadCount, 0)
}

export function totalUnreadCount(accounts: Account[], folders: Folder[]): number {
  return accounts.reduce(
    (sum, account) => sum + accountUnreadCount(account, folders),
    0
  )
}
