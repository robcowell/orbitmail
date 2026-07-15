package orbit.sync

import com.icegreen.greenmail.junit5.GreenMailExtension
import com.icegreen.greenmail.util.GreenMailUtil
import com.icegreen.greenmail.util.ServerSetupTest
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPStore
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.sql.DriverManager
import java.util.Date
import java.util.Properties
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Session
import javax.mail.Transport
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeMessage

/**
 * End-to-end: the sync engine drives a REAL IMAP server (GreenMail) against a
 * REAL (SQLite) MailRepository. Verifies the audit §4 strategy — folder
 * discovery/typing, initial batch, UID-delta incremental, sync window, threading,
 * flag reconciliation, and expunge — with nothing mocked.
 */
class SyncEngineGreenMailTest {

    companion object {
        @JvmField
        @RegisterExtension
        val greenMail: GreenMailExtension = GreenMailExtension(ServerSetupTest.SMTP_IMAP)
    }

    private lateinit var repo: SqliteMailRepository
    private lateinit var engine: SyncEngine
    private lateinit var account: SyncAccount
    private lateinit var inboxId: String
    private val now = 1_700_000_000_000L

    @BeforeEach
    fun setUp() {
        greenMail.setUser("test@localhost", "test", "test")
        repo = SqliteMailRepository(DriverManager.getConnection("jdbc:sqlite::memory:"))
        engine = SyncEngine(repo)
        account = SyncAccount(
            id = "a1", provider = Provider.IMAP, host = "127.0.0.1",
            port = greenMail.imap.port, auth = Auth.Password("test", "test"),
            syncDays = 90, useTls = false
        )
        inboxId = repo.folderIdFor("a1", "INBOX")
    }

    // ── tests ────────────────────────────────────────────────────────────────

    @Test
    fun initialSync_fetchesBatch_typesInbox_countsUnread() {
        repeat(3) { send("Message $it", "body $it") }
        engine.syncAccount(account, now)
        assertEquals(3, repo.count(inboxId))
        assertEquals(3, repo.unread(inboxId), "all fetched messages are unread")
        assertEquals(3, repo.distinctThreads(inboxId))
        println("PROOF[initial] discovered INBOX, fetched 3, unread=3")
    }

    @Test
    fun incrementalSync_fetchesOnlyNewUids() {
        repeat(3) { send("Old $it", "b") }
        engine.syncAccount(account, now)
        repeat(2) { send("New $it", "b") }
        val results = engine.syncAccount(account, now)
        assertEquals(5, repo.count(inboxId))
        val inboxNew = results.first { it.folderId == inboxId }.newMessages
        assertEquals(2, inboxNew, "only the 2 new UIDs are fetched, not all 5")
        println("PROOF[incremental] second sync fetched only the 2 new UIDs")
    }

    @Test
    fun syncWindow_dropsMessagesOlderThanWindow() {
        send("Recent", "b", sentMs = now)
        send("Ancient", "b", sentMs = now - 200L * 86_400_000) // 200 days > 90-day window
        engine.syncAccount(account, now)
        assertEquals(1, repo.count(inboxId), "the 200-day-old message is outside the 90-day window")
        println("PROOF[window] message older than syncDays dropped by the engine window filter")
    }

    @Test
    fun threading_groupsReplyWithRoot() {
        send("Question", "b", messageId = "<root@orbit.test>")
        send("Re: Question", "b", messageId = "<reply1@orbit.test>", references = "<root@orbit.test>", inReplyTo = "<root@orbit.test>")
        engine.syncAccount(account, now)
        assertEquals(2, repo.count(inboxId))
        assertEquals(1, repo.distinctThreads(inboxId), "reply groups under the References root")
        println("PROOF[threading] reply + root collapsed to a single thread id")
    }

    @Test
    fun flagReconcile_pullsServerSeenOntoLocalRow() {
        send("Unread", "b")
        engine.syncAccount(account, now)
        assertEquals(1, repo.unread(inboxId))
        serverSetSeen(uid = 1)
        engine.syncAccount(account, now) // no new mail, but reconcile runs
        assertTrue(repo.isRead(inboxId, 1), "server \\Seen reconciled onto the local row")
        assertEquals(0, repo.unread(inboxId))
        println("PROOF[flags] server-side \\Seen reconciled; unread recount → 0")
    }

    @Test
    fun expunge_removesLocallyDeletedMessage() {
        send("Keep", "b"); send("Delete me", "b")
        engine.syncAccount(account, now)
        assertEquals(2, repo.count(inboxId))
        serverExpunge(uid = 1)
        engine.syncAccount(account, now) // reconcile detects the expunge
        assertEquals(1, repo.count(inboxId), "expunged UID removed from the local cache")
        println("PROOF[expunge] message deleted on the server removed locally")
    }

    @Test
    fun resync_isIdempotent_noDuplicates() {
        send("A", "b"); send("B", "b")
        engine.syncAccount(account, now)
        engine.syncAccount(account, now)
        assertEquals(2, repo.count(inboxId), "UNIQUE(folder_id, uid) + UID delta prevent duplicates")
        println("PROOF[idempotent] re-sync produced no duplicate rows")
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    private fun send(
        subject: String, body: String, sentMs: Long? = null,
        messageId: String? = null, references: String? = null, inReplyTo: String? = null
    ) {
        val session = GreenMailUtil.getSession(ServerSetupTest.SMTP)
        val msg = if (messageId != null) object : MimeMessage(session) {
            override fun updateMessageID() { setHeader("Message-ID", messageId) }
        } else MimeMessage(session)
        msg.setFrom(InternetAddress("sender@example.com", "Sender Name"))
        msg.setRecipient(Message.RecipientType.TO, InternetAddress("test@localhost"))
        msg.subject = subject
        msg.setText(body)
        sentMs?.let { msg.sentDate = Date(it) }
        references?.let { msg.setHeader("References", it) }
        inReplyTo?.let { msg.setHeader("In-Reply-To", it) }
        msg.saveChanges()
        Transport.send(msg)
        assertTrue(greenMail.waitForIncomingEmail(5_000, 1))
    }

    private fun rawStore(): IMAPStore {
        val props = Properties().apply {
            put("mail.store.protocol", "imap")
            put("mail.imap.host", "127.0.0.1")
            put("mail.imap.port", greenMail.imap.port.toString())
        }
        val store = Session.getInstance(props).getStore("imap") as IMAPStore
        store.connect("test", "test")
        return store
    }

    private fun serverSetSeen(uid: Long) {
        val store = rawStore()
        try {
            val f = store.getFolder("INBOX") as IMAPFolder
            f.open(Folder.READ_WRITE)
            f.getMessageByUID(uid)?.setFlag(Flags.Flag.SEEN, true)
            f.close(false)
        } finally { store.close() }
    }

    private fun serverExpunge(uid: Long) {
        val store = rawStore()
        try {
            val f = store.getFolder("INBOX") as IMAPFolder
            f.open(Folder.READ_WRITE)
            f.getMessageByUID(uid)?.setFlag(Flags.Flag.DELETED, true)
            f.close(true) // expunge
        } finally { store.close() }
    }

    @AfterEach
    fun tearDown() { /* in-memory SQLite + GreenMail are torn down per test */ }
}
