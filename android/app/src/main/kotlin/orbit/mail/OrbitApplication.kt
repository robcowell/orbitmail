package orbit.mail

import android.app.Application
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import orbit.bg.service.BackgroundSyncHost
import orbit.bg.service.BackgroundSyncOutcome
import orbit.bg.service.SyncNotifications

/**
 * Owns the app-wide [AppGraph] and drives background sync (Step 6): reconciles
 * the SyncManager on startup and on every app foreground/background transition
 * (via [ProcessLifecycleOwner]), and satisfies [BackgroundSyncHost] so the
 * library's SyncWorker can run the real sync without depending on the app module.
 */
class OrbitApplication : Application(), BackgroundSyncHost {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        SyncNotifications.ensureChannels(this)

        // App start counts as background for the initial reconcile; the observer
        // below re-reconciles as foreground as soon as the process is resumed.
        graph.reconcileBackgroundSync(appInForeground = false)

        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) = graph.reconcileBackgroundSync(appInForeground = true)
            override fun onStop(owner: LifecycleOwner) = graph.reconcileBackgroundSync(appInForeground = false)
        })
    }

    override suspend fun runBackgroundSync(): BackgroundSyncOutcome = graph.runBackgroundSync()
}
