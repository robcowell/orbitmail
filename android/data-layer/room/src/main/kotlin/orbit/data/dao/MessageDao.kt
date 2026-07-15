package orbit.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow
import orbit.data.FlagColor
import orbit.data.FlagUpdate
import orbit.data.MessageSummary
import orbit.data.ThreadSummaryRow
import orbit.data.entity.MessageEntity

/**
 * The core message DAO. Non-trivial queries (thread collapse via window
 * functions, unified inbox, partial-index unread recount, scoped LIKE search,
 * cross-folder getThread) mirror the SQL verified in ../schema-verify.
 */
@Dao
interface MessageDao {

    // ── sync writes ───────────────────────────────────────────────────────────

    /**
     * Insert new messages, ignoring rows that already exist for (folder_id, uid).
     * Returns the rowId per input, or -1 where a row was ignored — the sync engine
     * uses -1 to detect which messages are *new* (isNew), mirroring
     * upsertMessagesBatch. Bodies are immutable per UID, so existing rows need no
     * body update; server-state drift is handled by [updateServerState] /
     * [applyFlagUpdates].
     */
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertIgnore(messages: List<MessageEntity>): List<Long>

    @Update
    suspend fun update(message: MessageEntity)

    // ── reads: flat list ──────────────────────────────────────────────────────

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages
           WHERE folder_id = :folderId AND (:unreadOnly = 0 OR is_read = 0)
           ORDER BY date DESC LIMIT :limit OFFSET :offset"""
    )
    fun listByFolder(folderId: String, unreadOnly: Boolean, limit: Int, offset: Int): Flow<List<MessageSummary>>

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages
           WHERE folder_id IN (SELECT id FROM folders WHERE type = 'inbox' AND is_virtual_view = 0)
             AND (:unreadOnly = 0 OR is_read = 0)
           ORDER BY date DESC LIMIT :limit OFFSET :offset"""
    )
    fun listUnified(unreadOnly: Boolean, limit: Int, offset: Int): Flow<List<MessageSummary>>

    @Query("SELECT COUNT(*) FROM messages WHERE folder_id = :folderId AND (:unreadOnly = 0 OR is_read = 0)")
    suspend fun countByFolder(folderId: String, unreadOnly: Boolean): Int

    // ── reads: threaded list (window functions) ───────────────────────────────

    @Query(
        """SELECT thread_id, account_id, id AS latest_message_id, from_addr, subject, snippet, date,
                  is_starred, flag_color, has_attachments, msg_count, has_unread
           FROM (
               SELECT m.*,
                   ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC, m.id DESC) AS rn,
                   COUNT(*)     OVER (PARTITION BY m.thread_id) AS msg_count,
                   MAX(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY m.thread_id) AS has_unread
               FROM messages m WHERE m.folder_id = :folderId
           )
           WHERE rn = 1 AND (:unreadOnly = 0 OR has_unread = 1)
           ORDER BY date DESC LIMIT :limit OFFSET :offset"""
    )
    fun listThreads(folderId: String, unreadOnly: Boolean, limit: Int, offset: Int): Flow<List<ThreadSummaryRow>>

    @Query(
        """SELECT thread_id, account_id, id AS latest_message_id, from_addr, subject, snippet, date,
                  is_starred, flag_color, has_attachments, msg_count, has_unread
           FROM (
               SELECT m.*,
                   ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC, m.id DESC) AS rn,
                   COUNT(*)     OVER (PARTITION BY m.thread_id) AS msg_count,
                   MAX(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY m.thread_id) AS has_unread
               FROM messages m
               WHERE m.folder_id IN (SELECT id FROM folders WHERE type = 'inbox' AND is_virtual_view = 0)
           )
           WHERE rn = 1 AND (:unreadOnly = 0 OR has_unread = 1)
           ORDER BY date DESC LIMIT :limit OFFSET :offset"""
    )
    fun listThreadsUnified(unreadOnly: Boolean, limit: Int, offset: Int): Flow<List<ThreadSummaryRow>>

    /** Whole conversation across folders, scoped by (account_id, thread_id). */
    @Query("SELECT * FROM messages WHERE account_id = :accountId AND thread_id = :threadId ORDER BY date ASC")
    suspend fun getThread(accountId: String, threadId: String): List<MessageEntity>

    @Query("SELECT * FROM messages WHERE id = :id")
    suspend fun getById(id: String): MessageEntity?

    // ── mutations (local; server propagation handled by the sync layer) ───────

    @Query("UPDATE messages SET is_read = :isRead WHERE id = :id")
    suspend fun setRead(id: String, isRead: Boolean)

    @Query("UPDATE messages SET is_starred = :isStarred WHERE id = :id")
    suspend fun setStarred(id: String, isStarred: Boolean)

    @Query("UPDATE messages SET flag_color = :flagColor WHERE id = :id")
    suspend fun setFlag(id: String, flagColor: FlagColor?)

    @Query("DELETE FROM messages WHERE id = :id")
    suspend fun deleteById(id: String)

    @Query("UPDATE messages SET is_read = :isRead, is_starred = :isStarred, flag_color = :flagColor WHERE id = :id")
    suspend fun updateServerState(id: String, isRead: Boolean, isStarred: Boolean, flagColor: FlagColor?)

    // ── incremental-sync primitives ───────────────────────────────────────────

    @Query("SELECT uid FROM messages WHERE folder_id = :folderId")
    suspend fun uidSet(folderId: String): List<Long>

    @Query("SELECT MAX(uid) FROM messages WHERE folder_id = :folderId")
    suspend fun maxUid(folderId: String): Long?

    @Query("SELECT COUNT(*) FROM messages WHERE folder_id = :folderId AND is_read = 0")
    suspend fun unreadCount(folderId: String): Int

    @Query("UPDATE messages SET is_read = :isRead, is_starred = :isStarred WHERE folder_id = :folderId AND uid = :uid")
    suspend fun updateFlagsByUid(folderId: String, uid: Long, isRead: Boolean, isStarred: Boolean): Int

    /** Batch flag reconciliation (CONDSTORE/full-scan result). Returns rows changed. */
    @Transaction
    suspend fun applyFlagUpdates(folderId: String, updates: List<FlagUpdate>): Int {
        var changed = 0
        for (u in updates) changed += updateFlagsByUid(folderId, u.uid, u.isRead, u.isStarred)
        return changed
    }

    @Query("DELETE FROM messages WHERE folder_id = :folderId AND uid IN (:uids)")
    suspend fun deleteByUid(folderId: String, uids: List<Long>): Int

    @Query("DELETE FROM messages WHERE folder_id = :folderId")
    suspend fun clearFolder(folderId: String)

    /** Drop messages older than the per-account sync window (cutoff = epoch ms). */
    @Query("DELETE FROM messages WHERE account_id = :accountId AND date < :cutoff")
    suspend fun pruneOlderThan(accountId: String, cutoff: Long)

    @Query("UPDATE messages SET is_read = 1 WHERE folder_id = :folderId AND is_read = 0")
    suspend fun markFolderAllRead(folderId: String): Int

    // ── scoped LIKE search (audit §9: the v1 query path; also covers From/To) ──

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages
           WHERE account_id = :accountId AND (
               from_addr LIKE :like OR to_addr LIKE :like OR subject LIKE :like
               OR snippet LIKE :like OR body_text LIKE :like)
           ORDER BY date DESC LIMIT :limit"""
    )
    suspend fun searchAll(accountId: String, like: String, limit: Int): List<MessageSummary>

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages WHERE account_id = :accountId AND from_addr LIKE :like
           ORDER BY date DESC LIMIT :limit"""
    )
    suspend fun searchFrom(accountId: String, like: String, limit: Int): List<MessageSummary>

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages WHERE account_id = :accountId AND to_addr LIKE :like
           ORDER BY date DESC LIMIT :limit"""
    )
    suspend fun searchTo(accountId: String, like: String, limit: Int): List<MessageSummary>

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages WHERE account_id = :accountId AND subject LIKE :like
           ORDER BY date DESC LIMIT :limit"""
    )
    suspend fun searchSubject(accountId: String, like: String, limit: Int): List<MessageSummary>

    @Query(
        """SELECT id, folder_id, account_id, uid, message_id, from_addr, to_addr, subject, snippet,
                  date, is_read, is_starred, flag_color, has_attachments, thread_id
           FROM messages WHERE account_id = :accountId AND body_text LIKE :like
           ORDER BY date DESC LIMIT :limit"""
    )
    suspend fun searchBody(accountId: String, like: String, limit: Int): List<MessageSummary>

    // ── AI caches ─────────────────────────────────────────────────────────────

    @Query("UPDATE messages SET ai_analysis = :json, ai_analysis_at = :at WHERE id = :id")
    suspend fun setAiAnalysis(id: String, json: String, at: Long)

    @Query("SELECT ai_analysis FROM messages WHERE id = :id")
    suspend fun getAiAnalysis(id: String): String?

    @Query("UPDATE messages SET sweep_cache = :json, sweep_cache_at = :at WHERE id = :id")
    suspend fun setSweepCache(id: String, json: String, at: Long)
}
