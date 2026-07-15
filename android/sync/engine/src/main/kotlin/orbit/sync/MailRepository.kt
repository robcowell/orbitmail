package orbit.sync

/**
 * The persistence port the sync engine needs. In the app this is implemented by
 * a thin adapter over the Step 2 Room DAOs (FolderDao/MessageDao); in tests it's
 * implemented over SQLite so the engine's algorithms run against real storage.
 *
 * Methods are blocking — the engine runs on an IO thread / coroutine dispatcher.
 * (The Room adapter can use Room's non-suspend DAO variants, or bridge suspend
 * DAOs on the caller's IO dispatcher.)
 */
interface MailRepository {
    /** Upsert a discovered folder, returning its stable local id. */
    fun upsertFolder(accountId: String, remote: RemoteFolder, type: FolderType): String

    fun folderState(folderId: String): FolderState

    fun updateFolderSyncState(folderId: String, uidValidity: Long?, highestSyncedUid: Long, serverMessageCount: Int?)

    /** UIDs already stored for this folder (for delta computation). */
    fun uidSet(folderId: String): Set<Long>

    fun maxUid(folderId: String): Long?

    /** Insert only messages whose (folderId, uid) is new; returns the count inserted. */
    fun insertNewMessages(messages: List<ParsedMessage>): Int

    /** Drop every message in a folder (UIDVALIDITY reset). */
    fun clearFolder(folderId: String)

    /** Apply flag deltas by UID; returns rows actually changed. */
    fun applyFlagUpdates(folderId: String, updates: List<FlagUpdate>): Int

    /** Remove messages whose UIDs were expunged on the server; returns rows removed. */
    fun deleteByUid(folderId: String, uids: List<Long>): Int

    /** Recompute + store the folder's unread count from local rows. */
    fun recalculateUnread(folderId: String)

    /** Re-derive thread ids for the account (new mail can bridge threads). */
    fun regroupThreads(accountId: String)

    /** Drop messages older than the account's sync window. */
    fun pruneOlderThan(accountId: String, cutoffEpochMs: Long)
}
