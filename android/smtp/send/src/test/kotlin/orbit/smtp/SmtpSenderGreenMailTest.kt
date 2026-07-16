package orbit.smtp

import com.icegreen.greenmail.junit5.GreenMailExtension
import com.icegreen.greenmail.util.GreenMailUtil
import com.icegreen.greenmail.util.ServerSetupTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.extension.RegisterExtension

/**
 * End-to-end: [SmtpSender] submits to a REAL SMTP server (GreenMail) with nothing
 * mocked. Verifies the desktop `smtp-send.ts` send contract — delivery, RFC 5322
 * threading headers, the mailer identity, multipart/alternative bodies, multi-
 * recipient (to/cc/bcc) fan-out, and the raw-bytes return used for Sent-append.
 *
 * The Password auth path is exercised here; XOAUTH2 is config-only and mirrors the
 * IMAP mechanism the spike already proved (real-account run is a Layer-3 handoff).
 */
class SmtpSenderGreenMailTest {

    companion object {
        @JvmField
        @RegisterExtension
        val greenMail: GreenMailExtension = GreenMailExtension(ServerSetupTest.SMTP)
    }

    private lateinit var account: SmtpAccount

    @BeforeEach
    fun setUp() {
        greenMail.setUser("sender@localhost", "sender", "pw")
        account = SmtpAccount(
            host = "127.0.0.1",
            port = greenMail.smtp.port,
            fromAddress = "sender@localhost",
            auth = SmtpAuth.Password("sender", "pw"),
            useStartTls = false
        )
    }

    @Test
    fun sendsPlainText_deliversWithSubjectAndBody() {
        SmtpSender.send(
            account,
            OutgoingMessage(to = "rcpt@localhost", subject = "Hello", bodyText = "Body text")
        )
        val received = greenMail.receivedMessages
        assertEquals(1, received.size)
        assertEquals("Hello", received[0].subject)
        assertTrue(GreenMailUtil.getBody(received[0]).contains("Body text"))
        println("PROOF[send] delivered 1 message, subject + body intact")
    }

    @Test
    fun setsThreadingAndMailerHeaders() {
        SmtpSender.send(
            account,
            OutgoingMessage(
                to = "rcpt@localhost", subject = "Re: Hi", bodyText = "x",
                inReplyTo = "<parent@id>", references = "<root@id> <parent@id>",
                userAgent = "Orbit Mail 0.1.0 (Android)"
            )
        )
        val m = greenMail.receivedMessages.single()
        assertEquals("<parent@id>", m.getHeader("In-Reply-To")?.firstOrNull())
        assertEquals("<root@id> <parent@id>", m.getHeader("References")?.firstOrNull())
        assertEquals("Orbit Mail 0.1.0 (Android)", m.getHeader("User-Agent")?.firstOrNull())
        assertEquals("Orbit Mail 0.1.0 (Android)", m.getHeader("X-Mailer")?.firstOrNull())
        println("PROOF[headers] In-Reply-To / References / User-Agent / X-Mailer set")
    }

    @Test
    fun htmlBody_producesMultipartAlternative() {
        SmtpSender.send(
            account,
            OutgoingMessage(to = "rcpt@localhost", subject = "HTML", bodyText = "plain", bodyHtml = "<b>rich</b>")
        )
        val m = greenMail.receivedMessages.single()
        assertTrue(
            m.contentType.contains("multipart/alternative", ignoreCase = true),
            "expected multipart/alternative, got ${m.contentType}"
        )
        println("PROOF[html] multipart/alternative carries text + html")
    }

    @Test
    fun toCcBcc_allEnvelopeRecipientsReceive() {
        SmtpSender.send(
            account,
            OutgoingMessage(
                to = "a@localhost", cc = "b@localhost", bcc = "c@localhost",
                subject = "multi", bodyText = "x"
            )
        )
        // GreenMail delivers one copy per envelope recipient.
        assertEquals(3, greenMail.receivedMessages.size)
        println("PROOF[recipients] to + cc + bcc all delivered")
    }

    @Test
    fun send_returnsRawRfc822Bytes() {
        val raw = SmtpSender.send(
            account,
            OutgoingMessage(to = "rcpt@localhost", subject = "Raw", bodyText = "hello")
        )
        val text = String(raw)
        assertTrue(text.contains("Subject: Raw"), "raw bytes should contain the Subject header")
        assertTrue(text.contains("hello"), "raw bytes should contain the body")
        println("PROOF[raw] send() returns RFC 822 bytes for Sent-folder append")
    }
}
