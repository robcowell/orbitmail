import type { SyncStatus, AccountSyncStatus } from '../../shared/types'

/**
 * What the status bar should say, derived from per-account sync status.
 *
 * Pure on purpose. The bug this replaces was one line of JSX — the last-synced
 * time was rendered only when `!syncStatus.error`, so a single failing mailbox
 * deleted the timestamp for every healthy one. That was invisible to every test
 * the repo has: `test:imap` is windowless and cannot mount a component, and
 * nothing else reached the renderer. Keeping the decision here as string and
 * number work means `test:store` can drive it under plain node.
 */
export interface SyncStatusSummary {
  /** Accounts reporting an error of their own, in map order. */
  failing: AccountSyncStatus[]
  /** One line for the bar. A single failure names itself; several are counted. */
  errorLabel: string | null
  /** Any failure that reads like an expired credential rather than a network blip. */
  needsReauth: boolean
  /**
   * Newest successful sync among accounts that are *not* failing, or null if
   * none has ever synced. A failing account never contributes its stale
   * timestamp here, and — the actual fix — never suppresses anyone else's.
   */
  healthyLastSyncAt: number | null
  /** True when some accounts are fine and others are not, which changes the wording. */
  mixed: boolean
}

/**
 * What the app can honestly say about connectivity.
 *
 * - `online` — normal.
 * - `offline` — the OS says there is no network. Reliable in this direction:
 *   when `navigator.onLine` is false it really is false.
 * - `unreachable` — the OS says there *is* a network, but every account that
 *   has tried failed to reach its server. This is the state the old banner
 *   could never show, and it is the common one: a captive portal, a dropped
 *   VPN, a DNS outage. Mail looks current and is not.
 */
export type Connectivity = 'online' | 'offline' | 'unreachable'

export interface ConnectivityView {
  state: Connectivity
  /** The banner text, or null when there is nothing to say. */
  message: string | null
}

export function summarizeSyncStatus(status: SyncStatus): SyncStatusSummary {
  const all = Object.values(status.accounts ?? {})
  const failing = all.filter((a) => a.error)
  const healthy = all.filter((a) => !a.error)

  const healthyLastSyncAt = healthy.reduce<number | null>(
    (newest, a) =>
      a.lastSyncAt !== null && (newest === null || a.lastSyncAt > newest)
        ? a.lastSyncAt
        : newest,
    null
  )

  return {
    failing,
    errorLabel:
      failing.length === 0
        ? null
        : failing.length === 1
          ? `${failing[0].email}: ${failing[0].error}`
          : `${failing.length} accounts are not syncing`,
    // Reported by the main process, where the failure is classified — not
    // re-derived from the wording of `error`. See AccountSyncStatus.
    needsReauth: failing.some((a) => a.needsReauth),
    healthyLastSyncAt,
    mixed: failing.length > 0 && healthy.length > 0
  }
}

/** The full per-account detail, for the summary line's tooltip. */
export function syncErrorDetail(failing: AccountSyncStatus[]): string {
  return failing.map((a) => `${a.email}: ${a.error}`).join('\n')
}

/**
 * `navigator.onLine` is trusted only when it says *no*. Chromium sets it from
 * whether a network interface exists, so a positive is nearly meaningless — it
 * is true on a hotel wifi that has intercepted every request. A negative is
 * dependable, so it short-circuits.
 */
export function deriveConnectivity(
  status: SyncStatus,
  navigatorOnline: boolean
): ConnectivityView {
  if (!navigatorOnline) {
    return { state: 'offline', message: 'Offline — showing cached mail' }
  }

  const tried = Object.values(status.accounts ?? {}).filter(
    (a) => a.reachedServer !== null
  )

  // Never claim an outage from silence. With no account configured, or none
  // yet attempted, there is no evidence either way — and mid-sync an account
  // has not finished failing yet.
  if (tried.length === 0 || status.syncing) return { state: 'online', message: null }

  // One account reaching its server proves the network works, so the others'
  // failures are theirs alone and belong on those accounts, not in a banner.
  if (tried.some((a) => a.reachedServer)) return { state: 'online', message: null }

  return {
    state: 'unreachable',
    message:
      tried.length === 1
        ? "Can't reach your mail server — showing cached mail"
        : "Can't reach your mail servers — showing cached mail"
  }
}
