package orbit.spike

import com.icegreen.greenmail.junit5.GreenMailExtension
import com.icegreen.greenmail.util.GreenMailUtil
import com.icegreen.greenmail.util.ServerSetupTest
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPMessage
import com.sun.mail.imap.IMAPStore
import com.sun.mail.imap.SortTerm
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension
import java.io.ByteArrayOutputStream
import java.io.PrintStream
import java.util.Properties
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.Session
import javax.mail.Transport
import javax.mail.UIDFolder
import javax.mail.event.MessageCountAdapter
import javax.mail.event.MessageCountEvent
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart
import javax.mail.search.FlagTerm

/**
 * LAYER 2 — end-to-end proof against a REAL in-process IMAP/SMTP server
 * (GreenMail speaks the actual protocol over a loopback socket; nothing is
 * mocked). This exercises the exact `com.sun.mail.imap.*` client code that
 * ships on Android, proving the mechanics most likely to surprise: IDLE push
 * and single-part BODYSTRUCTURE fetch, plus the FETCH/STORE/SEARCH/UID core.
 *
 * Gmail-only capabilities (CONDSTORE, SORT, XOAUTH2 against Google) are
 * capability-gated: GreenMail does not advertise them, so those tests report
 * SKIP here and are confirmed by Layer 1 (compile) + Layer 3 (real Gmail).
 */
class ImapSpikeTest {

    companion object {
        @JvmField
        @RegisterExtension
        val greenMail: GreenMailExtension = GreenMailExtension(ServerSetupTest.SMTP_IMAP)
    }

    @BeforeEach
    fun setUp() {
        greenMail.setUser("test@localhost", "test", "test")
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    private fun connect(): Pair<IMAPStore, ByteArrayOutputStream> {
        val trace = ByteArrayOutputStream()
        val props = Properties().apply {
            put("mail.store.protocol", "imap")
            put("mail.imap.host", "127.0.0.1")
            put("mail.imap.port", greenMail.imap.port.toString())
            // MUST be false to use the blocking folder.idle() on a dedicated
            // thread (the model this port uses). usesocketchannels=true forces the
            // async IdleManager API and makes folder.idle() throw. See SPIKE.md.
            put("mail.imap.usesocketchannels", "false")
        }
        val session = Session.getInstance(props)
        session.debug = true
        session.setDebugOut(PrintStream(trace, true, "UTF-8"))
        val store = session.getStore("imap") as IMAPStore
        store.connect("test", "test")
        return store to trace
    }

    private fun send(subject: String, attachmentText: String) {
        val session = GreenMailUtil.getSession(ServerSetupTest.SMTP)
        val msg = MimeMessage(session).apply {
            setFrom(InternetAddress("sender@example.com", "Sender Name"))
            setRecipient(Message.RecipientType.TO, InternetAddress("test@localhost"))
            this.subject = subject
        }
        val body = MimeBodyPart().apply { setText("Plain body for $subject") }
        val attachment = MimeBodyPart().apply {
            setText(attachmentText)
            fileName = "payload.txt"
        }
        msg.setContent(MimeMultipart().apply { addBodyPart(body); addBodyPart(attachment) })
        msg.saveChanges()
        Transport.send(msg)
        assertTrue(greenMail.waitForIncomingEmail(5_000, 1), "message not delivered to GreenMail")
    }

    // ── tests ────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("connect + report advertised CAPABILITY set")
    fun capabilities() {
        val (store, _) = connect()
        store.use {
            assertTrue(it.isConnected)
            val caps = listOf("IMAP4rev1", "IDLE", "UIDPLUS", "CONDSTORE", "SORT", "MOVE", "AUTH=XOAUTH2", "X-GM-EXT-1")
            val advertised = caps.filter { c -> it.hasCapability(c) }
            println("PROOF[capabilities] GreenMail advertises: $advertised")
            assertTrue(it.hasCapability("IMAP4rev1"))
            assertTrue(it.hasCapability("IDLE"), "IDLE must be advertised for push")
        }
    }

    @Test
    @DisplayName("CAP: FETCH envelope + flags + UID")
    fun fetchEnvelope() {
        send("Envelope Test", "irrelevant")
        val (store, _) = connect()
        store.use {
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_ONLY)
            val msg = inbox.getMessage(1)
            assertEquals("Envelope Test", msg.subject)
            assertEquals("Sender Name <sender@example.com>", (msg.from[0] as InternetAddress).toString())
            assertEquals(1L, inbox.getUID(msg))
            println("PROOF[fetch] subject/from/uid read via ENVELOPE ok")
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP 5: partial BODYSTRUCTURE fetch downloads ONE part, not the whole message")
    fun partialPartFetch() {
        val payload = "ATTACHMENT-PAYLOAD-42"
        send("Partial Fetch Test", payload)
        val (store, trace) = connect()
        store.use {
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_ONLY)
            val msg = inbox.getMessage(1) as IMAPMessage
            msg.setPeek(true) // inspect structure without setting \Seen

            val multipart = msg.content as MimeMultipart // fetches BODYSTRUCTURE, not bodies
            val attachmentPart = multipart.getBodyPart(multipart.count - 1)
            val fetched = attachmentPart.inputStream.readBytes().toString(Charsets.UTF_8).trim()

            assertEquals(payload, fetched, "attachment part content mismatch")

            val log = trace.toString(Charsets.UTF_8)
            // Strong evidence of a *partial* fetch: structure was requested, then a
            // single indexed part BODY[2], and the \Seen flag was NOT set (peek).
            assertTrue(log.contains("BODYSTRUCTURE"), "expected a BODYSTRUCTURE fetch in the protocol trace")
            assertTrue(log.contains("BODY[2]"), "expected a single-part BODY[2] fetch in the protocol trace")
            // No full-message BODY[] download occurred — only the one part.
            assertTrue(!log.contains("FETCH 1 (BODY[])"), "unexpected full-message body download")
            println("PROOF[partial-fetch] trace shows BODYSTRUCTURE then BODY[2]; downloaded only the attachment part ($payload)")
            log.lines().filter { it.contains("FETCH", true) && (it.contains("BODY", true)) }
                .forEach { println("  TRACE> ${it.trim()}") }
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP 2: IMAP IDLE delivers a real server push")
    fun idlePush() {
        val (store, trace) = connect()
        val inbox = store.getFolder("INBOX") as IMAPFolder
        inbox.open(Folder.READ_WRITE)

        val pushed = java.util.concurrent.atomic.AtomicBoolean(false)
        inbox.addMessageCountListener(object : MessageCountAdapter() {
            override fun messagesAdded(e: MessageCountEvent) { pushed.set(true) }
        })

        // Keep re-entering idle() in a loop: the blocking form returns after each
        // batch of unsolicited responses, so a single call can miss a later push.
        // Blocking idle() on a dedicated thread — the exact model an Android
        // foreground service would use. Re-enter after each returned batch.
        val idleThread = Thread {
            while (!pushed.get()) {
                try { inbox.idle() } catch (t: Throwable) { break }
            }
        }.apply { isDaemon = true; start() }
        Thread.sleep(1_000) // let the IDLE command get issued

        send("IDLE Push Test", "x") // arrives on a separate connection

        val deadline = System.currentTimeMillis() + 15_000
        while (System.currentTimeMillis() < deadline && !pushed.get()) Thread.sleep(100)

        if (!pushed.get()) {
            val tail = trace.toString(Charsets.UTF_8).lines().takeLast(30).joinToString("\n")
            println("DIAG[idle] no push; idle-connection protocol tail:\n$tail")
        }
        assertTrue(pushed.get(), "no IDLE push (EXISTS) received within 15s")
        println("PROOF[idle] server pushed EXISTS over IDLE; near-realtime delivery works")
        idleThread.interrupt()
    }

    @Test
    @DisplayName("CAP: STORE flags + SEARCH (read/star + server search fallback)")
    fun flagsAndSearch() {
        send("Flag Search Test", "y")
        val (store, _) = connect()
        store.use {
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_WRITE)
            val msg = inbox.getMessage(1)

            inbox.setFlags(arrayOf(msg), Flags(Flags.Flag.FLAGGED), true) // star
            assertTrue(msg.flags.contains(Flags.Flag.FLAGGED))

            val flagged = inbox.search(FlagTerm(Flags(Flags.Flag.FLAGGED), true))
            assertEquals(1, flagged.size)

            val unseen = inbox.search(FlagTerm(Flags(Flags.Flag.SEEN), false))
            assertEquals(1, unseen.size, "message should still be unseen (peeked)")
            println("PROOF[flags+search] set \\Flagged, SEARCH FLAGGED=1, SEARCH UNSEEN=1")
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP: UID incremental-sync primitives (UIDVALIDITY / UIDNEXT / by-UID)")
    fun uidPrimitives() {
        send("Uid One", "a")
        send("Uid Two", "b")
        val (store, _) = connect()
        store.use {
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_ONLY)
            assertTrue(inbox.uidValidity > 0, "UIDVALIDITY must be positive")
            assertTrue(inbox.uidNext > 0, "UIDNEXT must be positive")
            val byUid = inbox.getMessageByUID(1L)
            assertNotNull(byUid)
            val range = inbox.getMessagesByUID(1L, UIDFolder.LASTUID)
            assertEquals(2, range.size)
            println("PROOF[uid] uidValidity=${inbox.uidValidity} uidNext=${inbox.uidNext} rangeCount=${range.size}")
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP 4: SORT (skips if server lacks it — confirmed on Gmail in Layer 3)")
    fun sortIfSupported() {
        send("Sort A", "a")
        val (store, _) = connect()
        store.use {
            assumeTrue(it.hasCapability("SORT"), "GreenMail does not advertise SORT — verified against Gmail in Layer 3")
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_ONLY)
            val sorted = inbox.getSortedMessages(arrayOf(SortTerm.REVERSE, SortTerm.DATE))
            assertTrue(sorted.isNotEmpty())
            println("PROOF[sort] getSortedMessages returned ${sorted.size}")
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP 3: CONDSTORE/CHANGEDSINCE (skips if server lacks it — confirmed on Gmail in Layer 3)")
    fun condstoreIfSupported() {
        send("Condstore A", "a")
        val (store, _) = connect()
        store.use {
            assumeTrue(it.hasCapability("CONDSTORE"), "GreenMail does not advertise CONDSTORE — verified against Gmail in Layer 3")
            val inbox = it.getFolder("INBOX") as IMAPFolder
            inbox.open(Folder.READ_ONLY)
            val changed = inbox.getMessagesByUIDChangedSince(1L, UIDFolder.LASTUID, 1L)
            println("PROOF[condstore] CHANGEDSINCE returned ${changed.size}")
            inbox.close(false)
        }
    }

    @Test
    @DisplayName("CAP 1: XOAUTH2 SASL wire format is exactly what Gmail/Microsoft expect")
    fun xoauth2SaslFormat() {
        val ctrlA = '\u0001'
        val raw = Xoauth2.rawSaslToken("u@example.com", "TOK")
        // user=<email>^Aauth=Bearer <token>^A^A  (^A = Ctrl-A / 0x01)
        assertEquals("user=u@example.com${ctrlA}auth=Bearer TOK$ctrlA$ctrlA", raw)
        val expectedB64 = java.util.Base64.getEncoder()
            .encodeToString(raw.toByteArray(Charsets.UTF_8))
        assertEquals(expectedB64, Xoauth2.base64SaslToken("u@example.com", "TOK"))
        println("PROOF[xoauth2] SASL format verified: ${Xoauth2.base64SaslToken("u@example.com", "TOK")}")
    }
}
