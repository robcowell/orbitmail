package orbit.sync

import com.icegreen.greenmail.junit5.GreenMailExtension
import com.icegreen.greenmail.util.GreenMailUtil
import com.icegreen.greenmail.util.ServerSetupTest
import orbit.sync.imap.ImapConnection
import orbit.sync.imap.ImapConnectionFactory
import orbit.sync.imap.ImapMutations
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.util.Properties
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Session
import javax.mail.Store
import javax.mail.Transport
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeMessage

/**
 * End-to-end: [ImapMutations] drives a REAL IMAP server (GreenMail), the write-
 * path counterpart to the sync engine. Mirrors the desktop `imap-sync` ops —
 * mark \Seen/\Flagged, delete (expunge), and move (copy + expunge source).
 */
class ImapMutationsGreenMailTest {

    companion object {
        @JvmField
        @RegisterExtension
        val greenMail: GreenMailExtension = GreenMailExtension(ServerSetupTest.SMTP_IMAP)
    }

    private lateinit var account: SyncAccount
    private val mutations = ImapMutations()

    @BeforeEach
    fun setUp() {
        greenMail.setUser("test@localhost", "test", "test")
        account = SyncAccount(
            id = "a1", provider = Provider.IMAP, host = "127.0.0.1",
            port = greenMail.imap.port, auth = Auth.Password("test", "test"),
            syncDays = 90, useTls = false
        )
    }

    @Test
    fun setSeenAndFlagged_thenClear_propagate() {
        send("m1")
        val uid = inboxUids().single()

        mutations.setSeen(account, "INBOX", uid, true)
        mutations.setFlagged(account, "INBOX", uid, true)
        inboxFlags().single().let { (u, seen, flagged) ->
            assertEquals(uid, u); assertTrue(seen, "\\Seen set"); assertTrue(flagged, "\\Flagged set")
        }

        mutations.setSeen(account, "INBOX", uid, false)
        assertFalse(inboxFlags().single().second, "\\Seen cleared")
        println("PROOF[flags] \\Seen/\\Flagged set on server, then \\Seen cleared")
    }

    @Test
    fun delete_expungesOnlyThatMessage() {
        send("keep")
        send("drop")
        val uids = inboxUids().sorted()
        assertEquals(2, uids.size)

        mutations.delete(account, "INBOX", uids.last())

        val remaining = inboxUids()
        assertEquals(1, remaining.size)
        assertFalse(remaining.contains(uids.last()), "deleted uid gone")
        assertTrue(remaining.contains(uids.first()), "the other message survives")
        println("PROOF[delete] one message expunged from the server, the other untouched")
    }

    @Test
    fun move_copiesToTargetAndRemovesFromSource() {
        rawStore().use { store ->
            val archive = store.getFolder("Archive")
            if (!archive.exists()) archive.create(Folder.HOLDS_MESSAGES)
        }
        send("movable")
        val uid = inboxUids().single()

        mutations.move(account, "INBOX", uid, "Archive")

        assertEquals(0, inboxUids().size, "source INBOX no longer holds it")
        val archived = ImapConnectionFactory.connect(account).use { conn ->
            conn.withFolder("Archive", write = false) { it.allFlags().size }
        }
        assertEquals(1, archived, "message now present in the target folder")
        println("PROOF[move] copied to target, expunged from source")
    }

    // ── helpers ────────────────────────────────────────────────────────────────

    private fun send(subject: String) {
        val session = GreenMailUtil.getSession(ServerSetupTest.SMTP)
        val msg = MimeMessage(session)
        msg.setFrom(InternetAddress("sender@example.com"))
        msg.setRecipient(Message.RecipientType.TO, InternetAddress("test@localhost"))
        msg.subject = subject
        msg.setText("body")
        msg.saveChanges()
        Transport.send(msg)
        assertTrue(greenMail.waitForIncomingEmail(5_000, 1))
    }

    private fun <T> onInbox(block: (ImapConnection.OpenFolder) -> T): T =
        ImapConnectionFactory.connect(account).use { conn ->
            conn.withFolder("INBOX", write = false) { block(it) }
        }

    private fun inboxFlags(): List<Triple<Long, Boolean, Boolean>> = onInbox { it.allFlags() }
    private fun inboxUids(): List<Long> = onInbox { f -> f.allFlags().map { it.first } }

    private fun rawStore(): Store {
        val store = Session.getInstance(Properties()).getStore("imap")
        store.connect("127.0.0.1", greenMail.imap.port, "test", "test")
        return store
    }
}
