import type { Folder, FolderType } from '../../shared/types'

export function findAccountFolder(
  folders: Folder[],
  accountId: string,
  type: FolderType
): Folder | undefined {
  return folders.find((f) => f.accountId === accountId && f.type === type)
}

export function findArchiveFolder(
  folders: Folder[],
  accountId: string
): Folder | undefined {
  const accountFolders = folders.filter((f) => f.accountId === accountId)
  return accountFolders.find(
    (f) =>
      /archive|all mail/i.test(f.name) ||
      /archive|\[Gmail\]\/All Mail/i.test(f.imapPath)
  )
}
