package orbit.bg.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

/**
 * Periodic WorkManager poll — the fallback for non-IDLE accounts and the safety
 * net for IDLE ones (plan §2). Runs at the tightest cadence (≥15 min); each run
 * syncs only the accounts actually due, so per-account intervals are honoured
 * within one worker (verified: SyncSchedulePolicy.accountsDue).
 *
 * Deferred build (Android). The sync it runs is the Step 4 engine, proven
 * end-to-end against GreenMail.
 */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        // The app (Application) supplies the sync engine + account resolution; the
        // library stays app-agnostic. Absent host (shouldn't happen) → succeed.
        val host = applicationContext as? BackgroundSyncHost ?: return Result.success()
        val outcome = try {
            host.runBackgroundSync()
        } catch (_: Exception) {
            return Result.retry() // WorkManager applies its own exponential backoff
        }
        // New mail also flows into the UI via Room Flow (Step 2/5); notify too.
        SyncNotifications.postNewMail(applicationContext, outcome.newCount)
        return if (outcome.failed) Result.retry() else Result.success()
    }

    companion object {
        const val UNIQUE_WORK_NAME = "orbit-periodic-sync"
    }
}
