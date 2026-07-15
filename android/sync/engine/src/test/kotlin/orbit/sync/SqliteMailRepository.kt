package orbit.sync

import java.sql.Connection

/**
 * A real (SQLite) [MailRepository] for the engine tests — a stand-in for the
 * app's Room adapter over the Step 2 DAOs. Using an actual database (not a mock)
 * means the engine's persistence path — UNIQUE(folder_id,uid) dedupe, unread
 * recount, delete-by-uid — is genuinely exercised.
 */
class SqliteMailRepository(private val c: Connection) : MailRepository {

    init {
        c.createStatement().use { st ->
            st.execute("PRAGMA foreign_keys = ON")
            st.execute(
                """CREATE TABLE folders(
                     id TEXT PRIMARY KEY, account_id TEXT NOT NULL, imap_path TEXT NOT NULL,
                     name TEXT NOT NULL, type TEXT NOT NULL, unread_count INTEGER NOT NULL DEFAULT 0,
                     is_virtual_view INTEGER NOT NULL DEFAULT 0, uid_validity INTEGER,
                     highest_synced_uid INTEGER NOT NULL DEFAULT 0, server_message_count INTEGER)"""
            )
            st.execute(
                """CREATE TABLE messages(
                     id TEXT PRIMARY KEY, folder_id TEXT NOT NULL, account_id TEXT NOT NULL,
                     uid INTEGER NOT NULL, message_id TEXT, in_reply_to TEXT, "references" TEXT,
                     thread_id TEXT, from_addr TEXT NOT NULL, to_addr TEXT NOT NULL, cc TEXT,
                     subject TEXT NOT NULL, snippet TEXT NOT NULL, date INTEGER NOT NULL,
                     is_read INTEGER NOT NULL DEFAULT 0, is_starred INTEGER NOT NULL DEFAULT 0,
                     has_attachments INTEGER NOT NULL DEFAULT 0, body_text TEXT, body_html TEXT)"""
            )
            st.execute("CREATE UNIQUE INDEX messages_folder_uid_idx ON messages(folder_id, uid)")
        }
    }

    private fun folderId(accountId: String, path: String) = "$accountId::$path"

    override fun upsertFolder(accountId: String, remote: RemoteFolder, type: FolderType): String {
        val id = folderId(accountId, remote.path)
        c.prepareStatement(
            """INSERT INTO folders(id, account_id, imap_path, name, type, is_virtual_view)
               VALUES(?,?,?,?,?,?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type,
                    is_virtual_view=excluded.is_virtual_view"""
        ).use {
            it.setString(1, id); it.setString(2, accountId); it.setString(3, remote.path)
            it.setString(4, remote.name); it.setString(5, type.wire)
            it.setInt(6, if (FolderTyping.isVirtualView(Provider.IMAP, remote.path)) 1 else 0)
            it.executeUpdate()
        }
        return id
    }

    override fun folderState(folderId: String): FolderState =
        c.prepareStatement("SELECT account_id, imap_path, uid_validity, highest_synced_uid, server_message_count FROM folders WHERE id=?").use { ps ->
            ps.setString(1, folderId)
            ps.executeQuery().use { rs ->
                rs.next()
                FolderState(
                    id = folderId,
                    accountId = rs.getString(1),
                    imapPath = rs.getString(2),
                    uidValidity = rs.getObject(3)?.let { (it as Number).toLong() },
                    highestSyncedUid = rs.getLong(4),
                    serverMessageCount = rs.getObject(5)?.let { (it as Number).toInt() }
                )
            }
        }

    override fun updateFolderSyncState(folderId: String, uidValidity: Long?, highestSyncedUid: Long, serverMessageCount: Int?) {
        c.prepareStatement("UPDATE folders SET uid_validity=?, highest_synced_uid=?, server_message_count=? WHERE id=?").use {
            if (uidValidity != null) it.setLong(1, uidValidity) else it.setNull(1, java.sql.Types.INTEGER)
            it.setLong(2, highestSyncedUid)
            if (serverMessageCount != null) it.setInt(3, serverMessageCount) else it.setNull(3, java.sql.Types.INTEGER)
            it.setString(4, folderId); it.executeUpdate()
        }
    }

    override fun uidSet(folderId: String): Set<Long> =
        c.prepareStatement("SELECT uid FROM messages WHERE folder_id=?").use { ps ->
            ps.setString(1, folderId)
            ps.executeQuery().use { rs -> buildSet { while (rs.next()) add(rs.getLong(1)) } }
        }

    override fun maxUid(folderId: String): Long? =
        c.prepareStatement("SELECT MAX(uid) FROM messages WHERE folder_id=?").use { ps ->
            ps.setString(1, folderId)
            ps.executeQuery().use { rs -> if (rs.next() && rs.getObject(1) != null) rs.getLong(1) else null }
        }

    override fun insertNewMessages(messages: List<ParsedMessage>): Int {
        var inserted = 0
        val sql = """INSERT OR IGNORE INTO messages(
              id, folder_id, account_id, uid, message_id, in_reply_to, "references", thread_id,
              from_addr, to_addr, cc, subject, snippet, date, is_read, is_starred, has_attachments, body_text, body_html)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"""
        for (m in messages) {
            c.prepareStatement(sql).use {
                it.setString(1, "${m.folderId}::${m.uid}"); it.setString(2, m.folderId); it.setString(3, m.accountId)
                it.setLong(4, m.uid); it.setString(5, m.messageId); it.setString(6, m.inReplyTo)
                it.setString(7, m.references); it.setString(8, m.threadId); it.setString(9, m.from)
                it.setString(10, m.to); it.setString(11, m.cc); it.setString(12, m.subject)
                it.setString(13, m.snippet); it.setLong(14, m.date); it.setInt(15, if (m.isRead) 1 else 0)
                it.setInt(16, if (m.isStarred) 1 else 0); it.setInt(17, if (m.hasAttachments) 1 else 0)
                it.setString(18, m.bodyText); it.setString(19, m.bodyHtml)
                inserted += it.executeUpdate()
            }
        }
        return inserted
    }

    override fun clearFolder(folderId: String) {
        c.prepareStatement("DELETE FROM messages WHERE folder_id=?").use { it.setString(1, folderId); it.executeUpdate() }
    }

    override fun applyFlagUpdates(folderId: String, updates: List<FlagUpdate>): Int {
        var changed = 0
        for (u in updates) {
            c.prepareStatement(
                "UPDATE messages SET is_read=?, is_starred=? WHERE folder_id=? AND uid=? AND (is_read<>? OR is_starred<>?)"
            ).use {
                val r = if (u.isRead) 1 else 0; val s = if (u.isStarred) 1 else 0
                it.setInt(1, r); it.setInt(2, s); it.setString(3, folderId); it.setLong(4, u.uid)
                it.setInt(5, r); it.setInt(6, s)
                changed += it.executeUpdate()
            }
        }
        return changed
    }

    override fun deleteByUid(folderId: String, uids: List<Long>): Int {
        if (uids.isEmpty()) return 0
        val placeholders = uids.joinToString(",") { "?" }
        return c.prepareStatement("DELETE FROM messages WHERE folder_id=? AND uid IN ($placeholders)").use {
            it.setString(1, folderId)
            uids.forEachIndexed { i, uid -> it.setLong(i + 2, uid) }
            it.executeUpdate()
        }
    }

    override fun recalculateUnread(folderId: String) {
        c.prepareStatement(
            "UPDATE folders SET unread_count = (SELECT COUNT(*) FROM messages WHERE folder_id=? AND is_read=0) WHERE id=?"
        ).use { it.setString(1, folderId); it.setString(2, folderId); it.executeUpdate() }
    }

    // Thread ids are set at parse time from RFC headers; a cross-account regroup
    // pass is a DB-only refinement not needed for these engine tests.
    override fun regroupThreads(accountId: String) {}

    override fun pruneOlderThan(accountId: String, cutoffEpochMs: Long) {
        c.prepareStatement("DELETE FROM messages WHERE account_id=? AND date<?").use {
            it.setString(1, accountId); it.setLong(2, cutoffEpochMs); it.executeUpdate()
        }
    }

    // ── test helpers ─────────────────────────────────────────────────────────
    fun count(folderId: String): Int = scalar("SELECT COUNT(*) FROM messages WHERE folder_id=?", folderId)
    fun unread(folderId: String): Int = scalar("SELECT unread_count FROM folders WHERE id=?", folderId)
    fun distinctThreads(folderId: String): Int = scalar("SELECT COUNT(DISTINCT thread_id) FROM messages WHERE folder_id=?", folderId)
    fun isRead(folderId: String, uid: Long): Boolean =
        c.prepareStatement("SELECT is_read FROM messages WHERE folder_id=? AND uid=?").use { ps ->
            ps.setString(1, folderId); ps.setLong(2, uid)
            ps.executeQuery().use { it.next() && it.getInt(1) == 1 }
        }
    fun folderIdFor(accountId: String, path: String) = folderId(accountId, path)

    private fun scalar(sql: String, arg: String): Int =
        c.prepareStatement(sql).use { ps -> ps.setString(1, arg); ps.executeQuery().use { it.next(); it.getInt(1) } }
}
