import type { Account, Folder } from '../../shared/types'
import { totalUnreadCount } from '../../shared/folders'

/**
 * What the list header says about what you are looking at.
 *
 * The header used to be four icon toggles and no words: no folder name, no
 * count, no unread count. With "unread only" active the sole cue was a button's
 * pressed state, which is easy to leave on and then wonder where your mail went.
 * The totals already existed in the store — they simply had nowhere to appear
 * except the "Load more (20 of 143)" button, which is absent once a folder is
 * fully loaded.
 */
export interface ListHeaderView {
  /** The folder, or "All Inboxes". Never empty. */
  title: string
  /** The account a folder belongs to, when more than one account exists. */
  subtitle: string | null
  /**
   * "143 conversations", "20 of 143 messages", "no messages". Counts what the
   * list is actually showing, in the units it is showing them in.
   */
  count: string
  /** Unread in view, or null when there are none to mention. */
  unread: string | null
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

export function describeListHeader(input: {
  selectedFolderId: string | 'unified'
  folders: Folder[]
  accounts: Account[]
  threadedView: boolean
  unreadOnly: boolean
  /** How many rows are loaded, and how many exist. */
  loaded: number
  total: number
  searching: boolean
}): ListHeaderView {
  const folder =
    input.selectedFolderId === 'unified'
      ? null
      : input.folders.find((f) => f.id === input.selectedFolderId)

  const title =
    input.selectedFolderId === 'unified' ? 'All Inboxes' : (folder?.name ?? 'Mailbox')

  // Only worth saying whose folder this is when there is more than one account;
  // with one, the answer is never in doubt.
  const account =
    folder && input.accounts.length > 1
      ? input.accounts.find((a) => a.id === folder.accountId)
      : undefined
  const subtitle = account
    ? account.displayName === account.email
      ? account.email
      : account.displayName
    : null

  const noun = input.threadedView ? ['conversation', 'conversations'] : ['message', 'messages']
  // The filter is folded into the noun rather than shown as a separate badge:
  // "1 unread conversation" cannot be clipped away, and a badge beside it was —
  // the list pane is ~320px wide and the badge lost to the toggles.
  const filtering = input.unreadOnly && !input.searching
  const one = filtering ? `unread ${noun[0]}` : noun[0]
  const many = filtering ? `unread ${noun[1]}` : noun[1]

  // A partially-loaded list says so. Saying "143 conversations" while showing 20
  // is the kind of small lie that makes a count untrustworthy.
  const count =
    input.total === 0
      ? `no ${many}`
      : input.loaded < input.total
        ? `${input.loaded.toLocaleString()} of ${plural(input.total, one, many)}`
        : plural(input.total, one, many)

  const unreadTotal =
    input.selectedFolderId === 'unified'
      ? totalUnreadCount(input.accounts, input.folders)
      : (folder?.unreadCount ?? 0)

  return {
    title,
    subtitle,
    count,
    // While filtering to unread, the count *is* the unread count — repeating it
    // as "12 unread" beside "12 unread conversations" says the same thing twice.
    unread: unreadTotal > 0 && !filtering ? `${unreadTotal.toLocaleString()} unread` : null
  }
}
