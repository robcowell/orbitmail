export const DEFAULT_SYNC_DAYS = 90

/** Zero or negative means no date limit (still subject to batch size). */
export function getSyncCutoffTimestamp(syncDays: number): number | null {
  if (syncDays <= 0) return null
  return Date.now() - syncDays * 24 * 60 * 60 * 1000
}

export function isWithinSyncWindow(dateMs: number, syncDays: number): boolean {
  const cutoff = getSyncCutoffTimestamp(syncDays)
  if (cutoff == null) return true
  return dateMs >= cutoff
}

export function syncSinceDate(syncDays: number): Date | undefined {
  const cutoff = getSyncCutoffTimestamp(syncDays)
  return cutoff == null ? undefined : new Date(cutoff)
}
