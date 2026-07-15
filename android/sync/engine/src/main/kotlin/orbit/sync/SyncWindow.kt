package orbit.sync

/** Sync windowing — port of desktop `sync-policy.ts` (audit §4.2). */
object SyncWindow {
    const val DEFAULT_SYNC_DAYS = 90
    private const val DAY_MS = 24L * 60 * 60 * 1000

    /** Cutoff epoch-ms, or null for "no date limit" (syncDays <= 0). */
    fun cutoff(syncDays: Int, now: Long): Long? =
        if (syncDays <= 0) null else now - syncDays.toLong() * DAY_MS

    fun isWithinWindow(dateMs: Long, syncDays: Int, now: Long): Boolean {
        val c = cutoff(syncDays, now) ?: return true
        return dateMs >= c
    }
}
