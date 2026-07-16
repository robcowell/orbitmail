package orbit.mail

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import orbit.bg.service.ImapIdleForegroundService
import orbit.bg.service.SyncManager
import orbit.bg.service.SyncWorker
import java.util.concurrent.TimeUnit

/**
 * The execution-layer controllers behind [SyncManager] (the decisions are the
 * verified `SyncSchedulePolicy`'s). These are the thin Android glue the port
 * deferred: start/stop the IDLE foreground service, enqueue the periodic poll.
 */
class AndroidForegroundServiceController(
    private val context: Context
) : SyncManager.ForegroundServiceController {

    override fun ensureRunning(idleAccountIds: List<String>) {
        val intent = Intent(context, ImapIdleForegroundService::class.java).apply {
            putExtra(ImapIdleForegroundService.EXTRA_IDLE_ACCOUNTS, idleAccountIds.toTypedArray())
        }
        ContextCompat.startForegroundService(context, intent)
    }

    override fun stop() {
        context.stopService(Intent(context, ImapIdleForegroundService::class.java))
    }
}

class WorkManagerScheduler(
    private val context: Context
) : SyncManager.WorkScheduler {

    override fun enqueuePeriodic(intervalMinutes: Int) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(intervalMinutes.toLong(), TimeUnit.MINUTES)
            .setConstraints(
                Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
            )
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            SyncWorker.UNIQUE_WORK_NAME,
            // UPDATE keeps the one unique job and re-applies the (possibly changed) interval.
            ExistingPeriodicWorkPolicy.UPDATE,
            request
        )
    }
}
