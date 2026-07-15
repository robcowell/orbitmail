package orbit.data.verify

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.sql.Connection
import java.sql.SQLException

/**
 * Verifies the SQL *contract* of the Room data layer against a real SQLite
 * engine: schema DDL, indexes, foreign-key cascade, and the non-trivial DAO
 * queries (threading window-functions, unified inbox, partial-index unread
 * recount, cross-folder thread load, scoped LIKE search, sweep-task lifecycle).
 * Each Room `@Query` under android/data-layer/room mirrors one of these.
 */
class SchemaVerifyTest {

    private fun account(c: Connection, id: String, provider: String = "gmail", email: String = "$id@x.test") {
        c.prepareStatement("INSERT INTO accounts(id, provider, email, display_name, created_at) VALUES (?,?,?,?,0)").use {
            it.setString(1, id); it.setString(2, provider); it.setString(3, email); it.setString(4, id); it.executeUpdate()
        }
    }

    private fun folder(c: Connection, id: String, accountId: String, type: String, virtual: Int = 0, path: String = id) {
        c.prepareStatement(
            "INSERT INTO folders(id, account_id, imap_path, name, type, is_virtual_view) VALUES (?,?,?,?,?,?)"
        ).use {
            it.setString(1, id); it.setString(2, accountId); it.setString(3, path); it.setString(4, id)
            it.setString(5, type); it.setInt(6, virtual); it.executeUpdate()
        }
    }

    private fun message(
        c: Connection, id: String, folderId: String, accountId: String, uid: Int,
        subject: String, date: Long, threadId: String? = null, isRead: Int = 0,
        from: String = "sender@x.test", to: String = "you@x.test", body: String = subject
    ) {
        c.prepareStatement(
            """INSERT INTO messages(id, folder_id, account_id, uid, from_addr, to_addr, subject, snippet, date, thread_id, is_read, body_text)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"""
        ).use {
            it.setString(1, id); it.setString(2, folderId); it.setString(3, accountId); it.setInt(4, uid)
            it.setString(5, from); it.setString(6, to); it.setString(7, subject); it.setString(8, subject)
            it.setLong(9, date); it.setString(10, threadId); it.setInt(11, isRead); it.setString(12, body)
            it.executeUpdate()
        }
    }

    private fun count(c: Connection, sql: String): Int =
        c.createStatement().use { st -> st.executeQuery(sql).use { it.next(); it.getInt(1) } }

    // ── tests ────────────────────────────────────────────────────────────────

    @Test
    fun schemaApplies_andForeignKeyCascade() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1")
            folder(c, "f1", "a1", "inbox")
            message(c, "m1", "f1", "a1", 1, "Hi", 100)
            c.prepareStatement("INSERT INTO attachments(id, message_id, filename, mime_type, size) VALUES ('at1','m1','a.pdf','application/pdf',10)").use { it.executeUpdate() }

            assertEquals(1, count(c, "SELECT COUNT(*) FROM attachments"))
            // Deleting the account cascades folders → messages → attachments.
            c.createStatement().use { it.execute("DELETE FROM accounts WHERE id='a1'") }
            assertEquals(0, count(c, "SELECT COUNT(*) FROM folders"))
            assertEquals(0, count(c, "SELECT COUNT(*) FROM messages"))
            assertEquals(0, count(c, "SELECT COUNT(*) FROM attachments"))
            println("PROOF[cascade] delete account wiped folders/messages/attachments")
        }
    }

    @Test
    fun uniqueFolderUid_rejectsDuplicate() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1"); folder(c, "f1", "a1", "inbox")
            message(c, "m1", "f1", "a1", 42, "One", 1)
            val ex = assertThrows(SQLException::class.java) {
                message(c, "m2", "f1", "a1", 42, "Dup", 2) // same (folder_id, uid)
            }
            assertTrue(ex.message!!.contains("UNIQUE", ignoreCase = true))
            println("PROOF[unique-uid] duplicate (folder_id, uid) rejected: ${ex.message}")
        }
    }

    @Test
    fun partialUnreadIndex_isUsedByRecount() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1"); folder(c, "f1", "a1", "inbox")
            message(c, "m1", "f1", "a1", 1, "u", 1, isRead = 0)
            message(c, "m2", "f1", "a1", 2, "r", 2, isRead = 1)
            val plan = StringBuilder()
            c.createStatement().use { st ->
                st.executeQuery("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM messages WHERE folder_id='f1' AND is_read=0").use { rs ->
                    while (rs.next()) plan.append(rs.getString("detail")).append('\n')
                }
            }
            assertTrue(plan.contains("messages_folder_unread_idx"), "recount should use the partial unread index; plan was:\n$plan")
            assertEquals(1, count(c, "SELECT COUNT(*) FROM messages WHERE folder_id='f1' AND is_read=0"))
            println("PROOF[partial-index] unread recount uses messages_folder_unread_idx")
        }
    }

    @Test
    fun threadCollapse_windowFunction_oneRowPerThread() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1"); folder(c, "f1", "a1", "inbox")
            // Thread T1: two messages, newest unread. Thread T2: one message, read.
            message(c, "m1", "f1", "a1", 1, "Re: T1", 100, threadId = "T1", isRead = 1)
            message(c, "m2", "f1", "a1", 2, "Re: T1", 300, threadId = "T1", isRead = 0)
            message(c, "m3", "f1", "a1", 3, "T2", 200, threadId = "T2", isRead = 1)

            val sql = """
                SELECT latest_id, thread_id, date, msg_count, has_unread FROM (
                    SELECT m.id AS latest_id, m.thread_id AS thread_id, m.date AS date,
                        ROW_NUMBER() OVER (PARTITION BY m.thread_id ORDER BY m.date DESC, m.id DESC) AS rn,
                        COUNT(*)   OVER (PARTITION BY m.thread_id) AS msg_count,
                        MAX(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END) OVER (PARTITION BY m.thread_id) AS has_unread
                    FROM messages m WHERE m.folder_id = 'f1'
                ) WHERE rn = 1 ORDER BY date DESC
            """.trimIndent()

            data class Row(val latest: String, val thread: String, val count: Int, val unread: Int)
            val rows = c.createStatement().use { st ->
                st.executeQuery(sql).use { rs ->
                    buildList { while (rs.next()) add(Row(rs.getString("latest_id"), rs.getString("thread_id"), rs.getInt("msg_count"), rs.getInt("has_unread"))) }
                }
            }
            assertEquals(2, rows.size, "one row per thread")
            // Newest thread first (T1's latest m2 @300), then T2 @200.
            assertEquals("m2", rows[0].latest); assertEquals("T1", rows[0].thread)
            assertEquals(2, rows[0].count); assertEquals(1, rows[0].unread)
            assertEquals("m3", rows[1].latest); assertEquals("T2", rows[1].thread)
            assertEquals(1, rows[1].count); assertEquals(0, rows[1].unread)
            println("PROOF[threads] window-function collapse: 2 threads, latest=m2(count2,unread) then m3(count1,read)")
        }
    }

    @Test
    fun unifiedInbox_spansInboxFoldersOnly() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1"); account(c, "a2")
            folder(c, "a1-in", "a1", "inbox"); folder(c, "a1-sent", "a1", "sent")
            folder(c, "a2-in", "a2", "inbox"); folder(c, "gmail-all", "a2", "custom", virtual = 1)
            message(c, "m1", "a1-in", "a1", 1, "in1", 10)
            message(c, "m2", "a1-sent", "a1", 1, "sent1", 20)
            message(c, "m3", "a2-in", "a2", 1, "in2", 30)
            message(c, "m4", "gmail-all", "a2", 1, "all1", 40)

            val n = count(
                c,
                """SELECT COUNT(*) FROM messages WHERE folder_id IN
                   (SELECT id FROM folders WHERE type='inbox' AND is_virtual_view=0)"""
            )
            assertEquals(2, n, "unified inbox = inbox folders across accounts, excluding sent + virtual views")
            println("PROOF[unified] unified inbox spans 2 inbox folders, excludes sent/virtual")
        }
    }

    @Test
    fun getThread_crossFolder_byAccountAndThread() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1")
            folder(c, "in", "a1", "inbox"); folder(c, "sent", "a1", "sent")
            // A conversation whose replies live across Inbox + Sent, same thread_id.
            message(c, "m1", "in", "a1", 1, "Q", 100, threadId = "T1")
            message(c, "m2", "sent", "a1", 1, "Re: Q", 200, threadId = "T1")
            message(c, "m3", "in", "a1", 2, "Re: Q", 300, threadId = "T1")

            val ids = c.prepareStatement(
                "SELECT id FROM messages WHERE account_id=? AND thread_id=? ORDER BY date ASC"
            ).use { ps ->
                ps.setString(1, "a1"); ps.setString(2, "T1")
                ps.executeQuery().use { rs -> buildList { while (rs.next()) add(rs.getString(1)) } }
            }
            assertEquals(listOf("m1", "m2", "m3"), ids, "whole conversation across folders, chronological")
            println("PROOF[getThread] cross-folder conversation interleaved by date: $ids")
        }
    }

    @Test
    fun scopedLikeSearch() {
        OrbitSchema.openInMemory().use { c ->
            account(c, "a1"); folder(c, "f1", "a1", "inbox")
            message(c, "m1", "f1", "a1", 1, "Invoice March", 10, from = "billing@acme.test", body = "amount due")
            message(c, "m2", "f1", "a1", 2, "Lunch?", 20, from = "friend@x.test", body = "invoice was a joke")

            // scope=all → OR across from/to/subject/snippet/body
            val all = count(
                c,
                """SELECT COUNT(*) FROM messages WHERE account_id='a1' AND (
                     from_addr LIKE '%invoice%' OR to_addr LIKE '%invoice%' OR subject LIKE '%invoice%'
                     OR snippet LIKE '%invoice%' OR body_text LIKE '%invoice%')"""
            )
            assertEquals(2, all, "'invoice' matches m1 subject and m2 body under scope=all")

            // scope=from → only sender column
            val fromScope = count(c, "SELECT COUNT(*) FROM messages WHERE account_id='a1' AND from_addr LIKE '%billing%'")
            assertEquals(1, fromScope, "scope=from matches only the billing sender")
            println("PROOF[search] scope=all→2, scope=from→1 (scope-aware LIKE, incl. From/To)")
        }
    }

    @Test
    fun sweepTasks_replaceOpen_andComplete() {
        OrbitSchema.openInMemory().use { c ->
            fun addTask(folder: String, id: String, status: String = "open") {
                c.prepareStatement(
                    """INSERT INTO sweep_tasks(folder_id, id, task, priority, source_message_id, source_subject, source_from, status, created_at)
                       VALUES (?,?,?,?,?,?,?,?,0)"""
                ).use {
                    it.setString(1, folder); it.setString(2, id); it.setString(3, "do $id"); it.setString(4, "high")
                    it.setString(5, "src"); it.setString(6, "subj"); it.setString(7, "from"); it.setString(8, status)
                    it.executeUpdate()
                }
            }
            addTask("unified", "t1"); addTask("unified", "t2")
            // Complete t1 (persists as history), then a re-sweep replaces OPEN rows only.
            c.createStatement().use { it.execute("UPDATE sweep_tasks SET status='completed', completed_at=1 WHERE folder_id='unified' AND id='t1'") }
            c.createStatement().use { it.execute("DELETE FROM sweep_tasks WHERE folder_id='unified' AND status='open'") } // replace open
            addTask("unified", "t3") // fresh sweep result

            assertEquals(1, count(c, "SELECT COUNT(*) FROM sweep_tasks WHERE status='completed'"), "completed history retained")
            assertEquals(1, count(c, "SELECT COUNT(*) FROM sweep_tasks WHERE status='open'"), "only the new open task remains")
            // Composite PK (folder_id, id) blocks a duplicate task id per folder.
            val ex = assertThrows(SQLException::class.java) { addTask("unified", "t3") }
            assertTrue(ex.message!!.contains("PRIMARY KEY", ignoreCase = true) || ex.message!!.contains("UNIQUE", ignoreCase = true))
            println("PROOF[sweep] replace-open keeps completed history; composite PK dedupes per folder")
        }
    }

    @Test
    fun fts5_optional_searchPath() {
        OrbitSchema.openInMemory(withFts = true).use { c ->
            c.createStatement().use { it.execute("INSERT INTO messages_fts(message_id, subject, snippet, body_text) VALUES ('m1','Quarterly report','q','revenue up')") }
            val n = count(c, "SELECT COUNT(*) FROM messages_fts WHERE messages_fts MATCH 'revenue'")
            assertEquals(1, n)
            println("PROOF[fts5] FTS5 MATCH works — available as a future search path (LIKE is the v1 path)")
        }
    }
}
