package orbit.bg.service

import orbit.bg.AccountSyncPref
import orbit.bg.SyncSchedulePolicy

/**
 * Orchestrates the two background paths from the verified [SyncSchedulePolicy]:
 * the foreground IDLE service and the periodic WorkManager poll. Called on app
 * start, when prefs change, and on app foreground/background transitions.
 *
 * Deferred build (Android). Only the *decisions* here are the policy module's,
 * already unit-tested; this is the thin execution layer (start/stop service,
 * enqueue work).
 */
class SyncManager(
    private val prefsProvider: () -> List<AccountSyncPref>,
    private val service: ForegroundServiceController,
    private val work: WorkScheduler,
) {
    fun reconcile(appInForeground: Boolean) {
        val prefs = prefsProvider()

        // 1) Foreground IDLE service: run iff app open or any IDLE account.
        if (SyncSchedulePolicy.needsForegroundService(prefs, appInForeground)) {
            service.ensureRunning(SyncSchedulePolicy.idleAccounts(prefs))
        } else {
            service.stop()
        }

        // 2) Periodic WorkManager poll at the tightest cadence (clamped to 15m).
        work.enqueuePeriodic(SyncSchedulePolicy.workerIntervalMinutes(prefs))
    }

    /** Abstractions so this stays testable and free of direct Android types. */
    interface ForegroundServiceController {
        fun ensureRunning(idleAccountIds: List<String>)
        fun stop()
    }

    interface WorkScheduler {
        fun enqueuePeriodic(intervalMinutes: Int)
    }
}
