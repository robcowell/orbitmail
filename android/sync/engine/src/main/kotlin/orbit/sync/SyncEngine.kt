package orbit.sync

import orbit.sync.imap.ImapConnection
import orbit.sync.imap.ImapConnectionFactory

/**
 * The headless core sync engine (audit §4). Reproduces the desktop's *strategy*
 * on Jakarta Mail: folder discovery + typing, initial batch sync, UID-delta
 * incremental sync, UIDVALIDITY reset handling, full-scan flag reconciliation,
 * and expunge detection. UI-free and Android-free — verified end-to-end against
 * a real IMAP server (GreenMail) with a real (SQLite) [MailRepository].
 */
class SyncEngine(
    private val repo: MailRepository,
    private val connect: (SyncAccount) -> ImapConnection = ImapConnectionFactory::connect
) {
    companion object {
        const val SYNC_BATCH_SIZE = 200
    }

    /** Sync every selectable folder of an account. Returns total new messages. */
    fun syncAccount(account: SyncAccount, nowMs: Long = System.currentTimeMillis()): List<FolderSyncResult> {
        connect(account).use { conn ->
            val results = mutableListOf<FolderSyncResult>()
            val folders = conn.listFolders().filter { it.selectable }
            // Map remote → local ids first (so typing/virtual-view is consistent).
            val folderIds = folders.associateWith { remote ->
                repo.upsertFolder(account.id, remote, FolderTyping.detect(remote.name))
            }
            for ((remote, folderId) in folderIds) {
                val res = syncFolder(conn, account, folderId, remote.path, nowMs)
                val reconciled = reconcileFolderFlags(conn, folderId, remote.path)
                results += res.copy(flagChanges = reconciled.first, expunged = reconciled.second)
            }
            val totalNew = results.sumOf { it.newMessages }
            if (totalNew > 0) repo.regroupThreads(account.id)
            SyncWindow.cutoff(account.syncDays, nowMs)?.let { repo.pruneOlderThan(account.id, it) }
            return results
        }
    }

    /** Sync one folder: initial batch or UID-delta incremental. */
    fun syncFolder(conn: ImapConnection, account: SyncAccount, folderId: String, path: String, nowMs: Long): FolderSyncResult {
        return conn.withFolder(path, write = false) { open ->
            val serverValidity = open.uidValidity
            val stored = repo.folderState(folderId)
            val validityChanged = stored.uidValidity != null && stored.uidValidity != serverValidity
            val maxLocalUid = if (validityChanged) 0L else (repo.maxUid(folderId) ?: 0L)

            // Nothing new: refresh the cursor + unread and return.
            if (!validityChanged && open.uidNext <= maxLocalUid + 1) {
                repo.updateFolderSyncState(folderId, serverValidity, maxLocalUid, open.messageCount)
                repo.recalculateUnread(folderId)
                return@withFolder FolderSyncResult(folderId, 0, 0, 0)
            }

            val cutoff = SyncWindow.cutoff(account.syncDays, nowMs)
            val existing = repo.uidSet(folderId)
            val candidates = if (maxLocalUid == 0L) open.recentUids(SYNC_BATCH_SIZE, cutoff)
            else open.uidsAfter(maxLocalUid)
            val toFetch = candidates.filter { it !in existing }

            // UIDVALIDITY reset: only wipe the cache when we actually have a
            // replacement batch (desktop guard — don't blow away on a blip).
            if (validityChanged && toFetch.isNotEmpty()) repo.clearFolder(folderId)

            val parsed = open.fetchByUids(toFetch, folderId, account.id, nowMs)
                .filter { SyncWindow.isWithinWindow(it.date, account.syncDays, nowMs) }
            val newCount = repo.insertNewMessages(parsed)

            val highestSynced = maxOf(maxLocalUid, parsed.maxOfOrNull { it.uid } ?: 0L)
            repo.updateFolderSyncState(folderId, serverValidity, highestSynced, open.messageCount)
            repo.recalculateUnread(folderId)
            FolderSyncResult(folderId, newCount, 0, 0)
        }
    }

    /**
     * Full-scan flag reconciliation + expunge detection (audit §4.5). Pulls
     * server \Seen/\Flagged onto already-synced rows and removes locally any UID
     * no longer present on the server. Returns (flagChanges, expunged).
     *
     * (The CONDSTORE CHANGEDSINCE fast-path — compiled in the spike's
     * CapabilityReference — is the optimization layered on top when the server
     * advertises CONDSTORE; this full scan is the correct fallback and the path
     * GreenMail can exercise.)
     */
    fun reconcileFolderFlags(conn: ImapConnection, folderId: String, path: String): Pair<Int, Int> {
        return conn.withFolder(path, write = false) { open ->
            val localUids = repo.uidSet(folderId)
            if (localUids.isEmpty()) return@withFolder 0 to 0

            val serverFlags = open.allFlags() // (uid, seen, flagged) for every server message
            val survivors = serverFlags.mapTo(HashSet()) { it.first }

            val updates = serverFlags
                .filter { it.first in localUids }
                .map { FlagUpdate(it.first, isRead = it.second, isStarred = it.third) }
            val changed = repo.applyFlagUpdates(folderId, updates)

            val expunged = localUids.filter { it !in survivors }
            // Guard: never trust a full wipe unless the server confirms it empty.
            val wouldWipeAll = expunged.size == localUids.size
            val removed = if (expunged.isNotEmpty() && !(wouldWipeAll && open.messageCount > 0)) {
                repo.deleteByUid(folderId, expunged)
            } else 0

            if (changed > 0 || removed > 0) repo.recalculateUnread(folderId)
            changed to removed
        }
    }
}
