package orbit.mail.data

import kotlinx.coroutines.runBlocking
import orbit.data.dao.FolderDao
import orbit.data.dao.MessageDao
import orbit.data.entity.FolderEntity
import orbit.data.entity.MessageEntity
import orbit.sync.FlagUpdate
import orbit.sync.FolderState
import orbit.sync.FolderType
import orbit.sync.MailRepository
import orbit.sync.ParsedMessage
import orbit.sync.RemoteFolder
import orbit.data.FlagUpdate as DataFlagUpdate
import orbit.data.FolderType as DataFolderType

/**
 * Implements the Step 4 sync-engine port [MailRepository] over the Step 2 Room
 * DAOs — the adapter that composes the two modules. Maps the engine's models
 * (ParsedMessage, RemoteFolder, FolderState, FlagUpdate) to/from the Room
 * entities. The engine is blocking (runs on an IO thread), so the suspend DAO
 * calls are bridged with [runBlocking].
 *
 * Every method here backs a query verified in android/data-layer/schema-verify.
 */
class RoomMailRepository(
    private val folderDao: FolderDao,
    private val messageDao: MessageDao,
) : MailRepository {

    private fun folderId(accountId: String, path: String) = "$accountId::$path"

    override fun upsertFolder(accountId: String, remote: RemoteFolder, type: FolderType): String = runBlocking {
        val id = folderId(accountId, remote.path)
        val existing = folderDao.getById(id)
        folderDao.upsert(
            FolderEntity(
                id = id,
                accountId = accountId,
                imapPath = remote.path,
                name = remote.name,
                type = DataFolderType.from(type.wire),
                // Preserve sync-cursor columns across an upsert; only metadata changes here.
                unreadCount = existing?.unreadCount ?: 0,
                isVirtualView = existing?.isVirtualView ?: false,
                uidValidity = existing?.uidValidity,
                highestSyncedUid = existing?.highestSyncedUid ?: 0,
                lastSyncAt = existing?.lastSyncAt,
                initialSyncComplete = existing?.initialSyncComplete ?: false,
                highestModseq = existing?.highestModseq,
                serverMessageCount = existing?.serverMessageCount
            )
        )
        id
    }

    override fun folderState(folderId: String): FolderState = runBlocking {
        val f = folderDao.getById(folderId) ?: error("Folder $folderId not found")
        FolderState(f.id, f.accountId, f.imapPath, f.uidValidity, f.highestSyncedUid, f.serverMessageCount)
    }

    override fun updateFolderSyncState(folderId: String, uidValidity: Long?, highestSyncedUid: Long, serverMessageCount: Int?) = runBlocking {
        val f = folderDao.getById(folderId) ?: return@runBlocking
        folderDao.updateSyncState(folderId, uidValidity, highestSyncedUid, f.lastSyncAt, f.initialSyncComplete || highestSyncedUid > 0)
        folderDao.updateServerMessageCount(folderId, serverMessageCount)
    }

    override fun uidSet(folderId: String): Set<Long> = runBlocking { messageDao.uidSet(folderId).toSet() }

    override fun maxUid(folderId: String): Long? = runBlocking { messageDao.maxUid(folderId) }

    override fun insertNewMessages(messages: List<ParsedMessage>): Int = runBlocking {
        val entities = messages.map { p ->
            MessageEntity(
                id = "${p.folderId}::${p.uid}",
                folderId = p.folderId, accountId = p.accountId, uid = p.uid,
                messageId = p.messageId, inReplyTo = p.inReplyTo, references = p.references, threadId = p.threadId,
                from = p.from, to = p.to, cc = p.cc, subject = p.subject, snippet = p.snippet, date = p.date,
                isRead = p.isRead, isStarred = p.isStarred, flagColor = null, hasAttachments = p.hasAttachments,
                bodyHtml = p.bodyHtml, bodyText = p.bodyText
            )
        }
        // insertIgnore returns a rowId per input, -1 where (folder_id, uid) already existed.
        messageDao.insertIgnore(entities).count { it != -1L }
    }

    override fun clearFolder(folderId: String) = runBlocking { messageDao.clearFolder(folderId) }

    override fun applyFlagUpdates(folderId: String, updates: List<FlagUpdate>): Int = runBlocking {
        messageDao.applyFlagUpdates(folderId, updates.map { DataFlagUpdate(it.uid, it.isRead, it.isStarred) })
    }

    override fun deleteByUid(folderId: String, uids: List<Long>): Int = runBlocking { messageDao.deleteByUid(folderId, uids) }

    override fun recalculateUnread(folderId: String) = runBlocking {
        folderDao.updateUnread(folderId, messageDao.unreadCount(folderId))
    }

    // Thread ids are derived at parse time (ThreadUtil). A transitive cross-folder
    // regroup is a DB-only refinement (desktop regroupThreadsForAccount) — a
    // follow-on; the per-message thread id already groups conversations.
    override fun regroupThreads(accountId: String) { /* TODO: transitive regroup pass */ }

    override fun pruneOlderThan(accountId: String, cutoffEpochMs: Long) = runBlocking {
        messageDao.pruneOlderThan(accountId, cutoffEpochMs)
    }
}
