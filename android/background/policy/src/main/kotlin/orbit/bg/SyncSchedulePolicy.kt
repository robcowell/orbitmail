package orbit.bg

/**
 * The per-account sync mode — the user-facing IDLE-vs-polling toggle (plan §2).
 * IDLE gives instant push (via a foreground service holding the connection); Poll
 * trades immediacy for battery, at a user-chosen interval.
 */
sealed interface SyncMode {
    data object Idle : SyncMode
    data class Poll(val intervalMinutes: Int) : SyncMode
}

/**
 * A user's sync preference for one account. [serverSupportsIdle] is false when
 * the IMAP server doesn't advertise IDLE — the plan's automatic fallback to
 * polling (audit §4/Step 2), even if the user picked IDLE.
 */
data class AccountSyncPref(
    val accountId: String,
    val mode: SyncMode,
    val serverSupportsIdle: Boolean = true
)

/**
 * Decides what Android background machinery to run from the per-account prefs.
 * Pure logic — the SyncManager (deferred, Android) executes these decisions
 * (start/stop the foreground service, enqueue WorkManager).
 */
object SyncSchedulePolicy {

    /** Android caps periodic WorkManager at a 15-minute minimum. */
    const val WORKMANAGER_MIN_INTERVAL_MINUTES = 15

    /** Safety-net poll cadence for IDLE accounts (IDLE handles the live case). */
    const val IDLE_SAFETY_POLL_MINUTES = 30

    /** IDLE requested but unsupported → poll at the safety interval instead. */
    fun effectiveMode(pref: AccountSyncPref): SyncMode = when (pref.mode) {
        is SyncMode.Idle -> if (pref.serverSupportsIdle) SyncMode.Idle else SyncMode.Poll(IDLE_SAFETY_POLL_MINUTES)
        is SyncMode.Poll -> pref.mode
    }

    /** Accounts that get a live IDLE connection in the foreground service. */
    fun idleAccounts(prefs: List<AccountSyncPref>): List<String> =
        prefs.filter { effectiveMode(it) is SyncMode.Idle }.map { it.accountId }

    /**
     * Whether the foreground service (persistent notification + battery-opt
     * exemption) must run: while the app is open, OR whenever any account has
     * IDLE enabled (plan §2).
     */
    fun needsForegroundService(prefs: List<AccountSyncPref>, appInForeground: Boolean): Boolean =
        appInForeground || idleAccounts(prefs).isNotEmpty()

    /** Effective per-account poll interval (safety interval for IDLE accounts). */
    fun intervalMinutes(pref: AccountSyncPref): Int = when (val m = effectiveMode(pref)) {
        is SyncMode.Idle -> IDLE_SAFETY_POLL_MINUTES
        is SyncMode.Poll -> m.intervalMinutes
    }

    /**
     * The single periodic WorkManager interval: the tightest account cadence,
     * clamped to Android's 15-minute floor. Each run then syncs only the accounts
     * actually due ([accountsDue]), so a 15-min worker still honours 30/60-min
     * per-account choices.
     */
    fun workerIntervalMinutes(prefs: List<AccountSyncPref>): Int {
        if (prefs.isEmpty()) return WORKMANAGER_MIN_INTERVAL_MINUTES
        val tightest = prefs.minOf { intervalMinutes(it) }
        return maxOf(tightest, WORKMANAGER_MIN_INTERVAL_MINUTES)
    }

    /** Accounts whose interval has elapsed since their last successful sync. */
    fun accountsDue(prefs: List<AccountSyncPref>, lastSyncMs: Map<String, Long>, nowMs: Long): List<String> =
        prefs.filter { pref ->
            val last = lastSyncMs[pref.accountId] ?: 0L
            nowMs - last >= intervalMinutes(pref).toLong() * 60_000
        }.map { it.accountId }
}
