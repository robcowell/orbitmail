import type { Account, Folder } from '../../shared/types'

/**
 * Where a search runs, and whether it can run at all.
 *
 * `accountId: null` means **every account** — the unified-inbox scope. That is
 * the distinction this type exists to make: "no account" used to mean both
 * "search everything" and "nothing to search", and the ambiguity was resolved
 * the unhelpful way. "All Inboxes" — the view you would naturally live in — was
 * the one view whose search box was disabled, reading "Select a folder to
 * search", because the resolver returned null for it and null meant unusable.
 */
export interface SearchScope {
  /** null searches all accounts; a string scopes to one. */
  accountId: string | null
  /** What the placeholder calls this scope. */
  label: string
  /** False only when there is genuinely nothing to search. */
  enabled: boolean
}

function accountName(account: Pick<Account, 'email' | 'displayName'>): string {
  return account.displayName === account.email ? account.email : account.displayName
}

export function resolveSearchScope(
  selectedFolderId: string | 'unified',
  folders: Folder[],
  accounts: Pick<Account, 'id' | 'email' | 'displayName'>[]
): SearchScope {
  if (selectedFolderId === 'unified') {
    return {
      accountId: null,
      // Singular when there is only one account: "all accounts" reads oddly
      // when there is one, and the unified view exists regardless.
      label: accounts.length === 1 ? accountName(accounts[0]) : 'all accounts',
      enabled: accounts.length > 0
    }
  }

  const folder = folders.find((f) => f.id === selectedFolderId)
  const account = folder && accounts.find((a) => a.id === folder.accountId)
  if (!folder || !account) {
    // A folder id that resolves to nothing — mid-load, or a stale preference.
    // Not searchable, and deliberately not silently promoted to "everything".
    return { accountId: null, label: '', enabled: false }
  }

  return { accountId: account.id, label: accountName(account), enabled: true }
}

/** Placeholder text for the search box, given a resolved scope. */
export function searchPlaceholder(scope: SearchScope): string {
  if (!scope.enabled) return 'Nothing to search yet'
  return `Search ${scope.label}…`
}

/**
 * What each result row's folder should be called.
 *
 * Unified search introduces a problem single-account search never had: nearly
 * every account has a folder called "Inbox", so an unqualified label leaves two
 * results looking identical and gives no clue which mailbox either came from.
 *
 * Qualified **only when the results actually span accounts** — adding the
 * account name to every row of a single-account search is noise, and the
 * placeholder has already said whose mail is being searched.
 */
export function searchFolderLabels(
  results: { folderId: string; accountId: string }[],
  folders: Pick<Folder, 'id' | 'name'>[],
  accounts: Pick<Account, 'id' | 'email' | 'displayName'>[]
): Map<string, string> {
  const labels = new Map<string, string>()
  if (results.length === 0) return labels

  const spansAccounts = results.some((r) => r.accountId !== results[0].accountId)
  const folderName = new Map(folders.map((f) => [f.id, f.name]))
  const accountById = new Map(accounts.map((a) => [a.id, a]))

  for (const result of results) {
    if (labels.has(result.folderId)) continue
    const name = folderName.get(result.folderId) ?? 'Mailbox'
    const account = accountById.get(result.accountId)
    labels.set(
      result.folderId,
      spansAccounts && account ? `${name} · ${accountName(account)}` : name
    )
  }
  return labels
}
