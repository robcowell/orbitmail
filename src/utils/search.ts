import type { Folder } from '../../shared/types'

export function resolveSearchAccountId(
  selectedFolderId: string | 'unified',
  folders: Folder[]
): string | null {
  if (selectedFolderId === 'unified') return null
  return folders.find((folder) => folder.id === selectedFolderId)?.accountId ?? null
}

export function searchAccountLabel(
  accountId: string | null,
  accounts: { id: string; email: string; displayName: string }[]
): string | null {
  if (!accountId) return null
  const account = accounts.find((entry) => entry.id === accountId)
  if (!account) return null
  return account.displayName === account.email ? account.email : account.displayName
}
