package orbit.mail

import android.app.Application

/** Owns the app-wide [AppGraph]. */
class OrbitApplication : Application() {
    lateinit var graph: AppGraph
        private set

    override fun onCreate() {
        super.onCreate()
        graph = AppGraph(this)
        // TODO: SyncManager.reconcile(appInForeground = false) on startup to
        // enqueue the WorkManager poll / start the IDLE foreground service
        // per the verified SyncSchedulePolicy (Step 6).
    }
}
