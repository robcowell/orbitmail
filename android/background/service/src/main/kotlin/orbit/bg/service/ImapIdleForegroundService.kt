package orbit.bg.service

import android.app.Service
import android.content.Intent
import android.os.IBinder
import com.sun.mail.imap.IMAPFolder
import kotlin.concurrent.thread

/**
 * Foreground service holding a live IMAP IDLE connection per IDLE-enabled account
 * (plan §2). Uses the spike-proven model: blocking `folder.idle()` on a dedicated
 * thread, `usesocketchannels=false` (Finding 2), reconnect on drop. On an EXISTS
 * push it runs a sync (Step 4 engine) and posts a new-mail notification.
 *
 * Requires a persistent notification (startForeground) and, to survive Doze,
 * the battery-optimization exemption (see [BatteryOptimization]).
 *
 * Deferred build (Android). The IDLE mechanics themselves are proven end-to-end
 * in android/imap-spike (CAP 2). This wires them into Android's lifecycle.
 */
class ImapIdleForegroundService : Service() {

    private val runtimes = mutableMapOf<String, IdleRuntime>()

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        SyncNotifications.ensureChannels(this)
        startForeground(NOTIF_ID, buildOngoingNotification())
        val accountIds = intent?.getStringArrayExtra(EXTRA_IDLE_ACCOUNTS)?.toList().orEmpty()
        syncRuntimes(accountIds)
        return START_STICKY
    }

    /** Start IDLE for newly-enabled accounts; stop it for removed ones. */
    private fun syncRuntimes(accountIds: List<String>) {
        (runtimes.keys - accountIds.toSet()).forEach { stopIdle(it) }
        accountIds.filter { it !in runtimes }.forEach { startIdle(it) }
        if (runtimes.isEmpty()) stopSelf()
    }

    private fun startIdle(accountId: String) {
        val runtime = IdleRuntime(accountId)
        runtimes[accountId] = runtime
        runtime.thread = thread(isDaemon = true, name = "idle-$accountId") { runtime.loop() }
    }

    private fun stopIdle(accountId: String) {
        runtimes.remove(accountId)?.let { it.stopping = true; it.closeQuietly() }
    }

    override fun onDestroy() {
        runtimes.keys.toList().forEach { stopIdle(it) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * Per-account IDLE loop. Sketch — the real body resolves a fresh access token
     * (Step 3 freshAccessToken), opens the account's SyncAccount, connects, opens
     * INBOX, registers a MessageCountListener that triggers the Step 4 sync +
     * notification, then re-enters blocking idle() until stopped. Reconnects after
     * IDLE_RECONNECT_MS on error/close.
     */
    private inner class IdleRuntime(val accountId: String) {
        @Volatile var stopping = false
        var thread: Thread? = null
        private var folder: IMAPFolder? = null

        fun loop() {
            while (!stopping) {
                try {
                    // val account = accountProvider(accountId)  // host/port + Auth.XOAuth2(freshToken)
                    // val conn = ImapConnectionFactory.connect(account)
                    // open INBOX, addMessageCountListener { onNewMail(accountId) }, then:
                    // while (!stopping) folder.idle()
                    Thread.sleep(IDLE_RECONNECT_MS) // placeholder for the deferred body
                } catch (_: InterruptedException) {
                    return
                } catch (_: Exception) {
                    if (stopping) return
                    Thread.sleep(IDLE_RECONNECT_MS) // reconnect backoff
                }
            }
        }

        fun closeQuietly() {
            try { folder?.close(false) } catch (_: Exception) {}
            thread?.interrupt()
        }
    }

    private fun buildOngoingNotification(): android.app.Notification =
        SyncNotifications.ongoing(this)

    companion object {
        const val NOTIF_ID = 1001
        const val EXTRA_IDLE_ACCOUNTS = "idle_accounts"
        const val IDLE_RECONNECT_MS = 5_000L // mirrors desktop imap-idle.ts
    }
}
