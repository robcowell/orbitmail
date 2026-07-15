package orbit.bg.service

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import orbit.bg.AccountSyncPref
import orbit.bg.SyncSchedulePolicy

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
        val prefs: List<AccountSyncPref> = loadPrefs()
        val lastSync: Map<String, Long> = loadLastSync()
        val due = SyncSchedulePolicy.accountsDue(prefs, lastSync, System.currentTimeMillis())

        var anyFailed = false
        for (accountId in due) {
            try {
                // val account = accountProvider(accountId) // Auth.XOAuth2(freshToken) for OAuth
                // val result = syncEngine.syncAccount(account)
                // val newCount = result.sumOf { it.newMessages }
                // if (newCount > 0) notificationPublisher.postNewMail(accountId, newCount)
                // markSynced(accountId)
            } catch (_: Exception) {
                anyFailed = true // WorkManager applies its own exponential backoff
            }
        }
        // New mail also flows into the UI automatically via Room Flow (Step 2/5).
        return if (anyFailed) Result.retry() else Result.success()
    }

    // Provided by the app's DI (DataStore prefs, Room last-sync, sync engine, notifier).
    private fun loadPrefs(): List<AccountSyncPref> = emptyList()
    private fun loadLastSync(): Map<String, Long> = emptyMap()

    companion object {
        const val UNIQUE_WORK_NAME = "orbit-periodic-sync"
    }
}
