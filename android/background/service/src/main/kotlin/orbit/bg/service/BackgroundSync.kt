package orbit.bg.service

/**
 * The app's background-sync entry point, resolved by the worker/service from the
 * `Application` (which implements this). Keeps `:background:service` free of any
 * app-module dependency — the library defines the contract, the app supplies the
 * sync engine + account resolution behind it.
 */
interface BackgroundSyncHost {
    /** Sync the accounts due for a background poll; returns the outcome. */
    suspend fun runBackgroundSync(): BackgroundSyncOutcome
}

/** Result of one background poll — new-message tally + whether any account failed. */
data class BackgroundSyncOutcome(val newCount: Int, val failed: Boolean)
