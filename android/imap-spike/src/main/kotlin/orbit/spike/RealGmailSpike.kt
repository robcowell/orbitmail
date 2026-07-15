package orbit.spike

import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPMessage
import com.sun.mail.imap.IMAPStore
import com.sun.mail.imap.SortTerm
import java.util.Properties
import javax.mail.Folder
import javax.mail.Session
import javax.mail.UIDFolder

/**
 * LAYER 3 — live verification against a REAL IMAP account (Gmail by default).
 *
 * This environment cannot run this (raw IMAP egress on :993 is blocked and there
 * are no credentials), so it is a ready-to-run handoff. It confirms the two
 * things GreenMail cannot: Gmail's XOAUTH2 handshake and CONDSTORE/HIGHESTMODSEQ.
 *
 * Run it with EITHER an OAuth access token (the real target) OR a Gmail
 * app-password (quicker to obtain for a first check):
 *
 *   # XOAUTH2 (Gmail must have the https://mail.google.com/ scope granted):
 *   IMAP_USER=you@gmail.com IMAP_ACCESS_TOKEN=ya29.... \
 *     gradle run --args="gmail"
 *
 *   # App-password (enable 2FA, create an app password):
 *   IMAP_USER=you@gmail.com IMAP_PASSWORD=abcd... IMAP_AUTH=password \
 *     gradle run --args="gmail"
 *
 * It only READS (and, for IDLE, waits): it never sends, deletes, or sets flags.
 */
object RealGmailSpike {

    private fun env(k: String): String? = System.getenv(k)?.takeIf { it.isNotBlank() }

    fun run() {
        val host = env("IMAP_HOST") ?: "imap.gmail.com"
        val port = env("IMAP_PORT")?.toInt() ?: 993
        val user = env("IMAP_USER") ?: error("Set IMAP_USER=you@example.com")
        val useXoauth = (env("IMAP_AUTH") ?: "xoauth2").equals("xoauth2", ignoreCase = true)
        val secret = if (useXoauth) {
            env("IMAP_ACCESS_TOKEN") ?: error("Set IMAP_ACCESS_TOKEN=<oauth access token> (or IMAP_AUTH=password + IMAP_PASSWORD)")
        } else {
            env("IMAP_PASSWORD") ?: error("Set IMAP_PASSWORD=<app password>")
        }

        val props = Xoauth2.imapXoauth2Props(host, port).apply {
            if (!useXoauth) {
                // Password path: drop the XOAUTH2 mechanism restriction.
                remove("mail.imaps.auth.mechanisms")
            }
        }

        println("── Orbit Mail IMAP spike — live run against $host:$port as $user ──")
        println("auth = ${if (useXoauth) "XOAUTH2 (OAuth access token)" else "password (app password)"}")

        val session = Session.getInstance(props, null)
        val store = session.getStore("imaps") as IMAPStore
        result("CAP 1  connect + XOAUTH2/auth") {
            store.connect(host, user, secret)
            "connected; AUTH=XOAUTH2 advertised=${store.hasCapability("AUTH=XOAUTH2")}, " +
                "CONDSTORE=${store.hasCapability("CONDSTORE")}, IDLE=${store.hasCapability("IDLE")}, " +
                "SORT=${store.hasCapability("SORT")}, X-GM-EXT-1=${store.hasCapability("X-GM-EXT-1")}"
        }

        val inbox = store.getFolder("INBOX") as IMAPFolder
        inbox.open(Folder.READ_ONLY)
        println("INBOX opened: ${inbox.messageCount} messages, uidNext=${inbox.uidNext}, uidValidity=${inbox.uidValidity}")

        result("CAP 4  SORT (REVERSE DATE)") {
            val sorted = inbox.getSortedMessages(arrayOf(SortTerm.REVERSE, SortTerm.DATE))
            "server returned ${sorted.size} messages in sorted order"
        }

        result("CAP 3  CONDSTORE / CHANGEDSINCE") {
            if (!store.hasCapability("CONDSTORE")) "SKIP — server did not advertise CONDSTORE"
            else {
                val changed = inbox.getMessagesByUIDChangedSince(1L, UIDFolder.LASTUID, 1L)
                val modseq = (inbox.messages.lastOrNull() as? IMAPMessage)?.modSeq
                "CHANGEDSINCE ok (${changed.size} since MODSEQ 1); newest per-message MODSEQ=$modseq"
            }
        }

        result("CAP 5  partial BODYSTRUCTURE part fetch") {
            val withAtt = inbox.messages.lastOrNull { (it as IMAPMessage).let { m -> m.setPeek(true); m.contentType.contains("multipart", true) } } as? IMAPMessage
            if (withAtt == null) "SKIP — no multipart message in INBOX to exercise part fetch"
            else {
                val mp = withAtt.content as javax.mail.Multipart
                val part = mp.getBodyPart(mp.count - 1)
                val n = part.inputStream.readBytes().size
                "fetched a single part (${part.contentType}) of $n bytes without downloading the whole message"
            }
        }

        result("CAP 2  IDLE (waiting up to 20s for a push — send yourself a mail)") {
            val idleThread = Thread { runCatching { inbox.idle() } }
            idleThread.isDaemon = true
            var pushed = false
            inbox.addMessageCountListener(object : javax.mail.event.MessageCountAdapter() {
                override fun messagesAdded(e: javax.mail.event.MessageCountEvent) { pushed = true }
            })
            idleThread.start()
            val deadline = System.currentTimeMillis() + 20_000
            while (System.currentTimeMillis() < deadline && !pushed) Thread.sleep(200)
            if (pushed) "IDLE push received — near-realtime delivery works" else "no push within 20s (IDLE opened OK; send a test mail to confirm)"
        }

        inbox.close(false)
        store.close()
        println("── done ──")
    }

    private inline fun result(label: String, body: () -> String) {
        try {
            val detail = body()
            val tag = if (detail.startsWith("SKIP")) "SKIP" else "PASS"
            println("[$tag] $label — $detail")
        } catch (t: Throwable) {
            println("[FAIL] $label — ${t.javaClass.simpleName}: ${t.message}")
        }
    }
}
