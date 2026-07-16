package orbit.bg.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * The two notification channels the background sync uses (minSdk 26, so channels
 * always exist): a silent, low-importance ongoing notification for the IDLE
 * foreground service, and a default-importance channel for new-mail alerts.
 */
object SyncNotifications {
    const val ONGOING_CHANNEL = "orbit_sync"
    const val NEW_MAIL_CHANNEL = "orbit_new_mail"
    const val NEW_MAIL_NOTIF_ID = 2001

    fun ensureChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(ONGOING_CHANNEL, "Background sync", NotificationManager.IMPORTANCE_LOW)
                .apply { description = "Keeps mail syncing while Orbit Mail is closed" }
        )
        manager.createNotificationChannel(
            NotificationChannel(NEW_MAIL_CHANNEL, "New mail", NotificationManager.IMPORTANCE_DEFAULT)
                .apply { description = "Notifies you when new mail arrives" }
        )
    }

    /** The persistent notification the foreground IDLE service must post. */
    fun ongoing(context: Context): Notification =
        NotificationCompat.Builder(context, ONGOING_CHANNEL)
            .setContentTitle("Orbit Mail")
            .setContentText("Syncing mail")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

    /** Post a new-mail alert (no-op silently if POST_NOTIFICATIONS isn't granted). */
    fun postNewMail(context: Context, newCount: Int) {
        if (newCount <= 0) return
        val text = if (newCount == 1) "1 new message" else "$newCount new messages"
        // Framework placeholder icon — a dedicated mail glyph is a follow-up.
        val notification = NotificationCompat.Builder(context, NEW_MAIL_CHANNEL)
            .setContentTitle("Orbit Mail")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NEW_MAIL_NOTIF_ID, notification)
        } catch (_: SecurityException) {
            // POST_NOTIFICATIONS not granted (API 33+) — new mail still lands in the UI.
        }
    }
}
