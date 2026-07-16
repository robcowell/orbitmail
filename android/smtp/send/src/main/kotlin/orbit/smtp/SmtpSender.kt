package orbit.smtp

import java.io.ByteArrayOutputStream
import java.util.Date
import java.util.Properties
import javax.mail.Message
import javax.mail.Session
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeBodyPart
import javax.mail.internet.MimeMessage
import javax.mail.internet.MimeMultipart

/**
 * Submits mail over SMTP — a direct port of the desktop `smtp-send.ts` send path.
 * XOAUTH2 mirrors the IMAP factory (`mail.smtp.auth.mechanisms=XOAUTH2`, access
 * token supplied as the connect password), so the Step 3 OAuth token flows
 * straight through. Blocking Jakarta Mail — call on an IO dispatcher.
 */
object SmtpSender {

    /**
     * Build and send [message] via [account]. Returns the raw RFC 822 bytes of
     * the submitted message so the caller can APPEND it to the Sent folder.
     */
    fun send(account: SmtpAccount, message: OutgoingMessage, sentDate: Date = Date()): ByteArray {
        val props = Properties().apply {
            put("mail.transport.protocol", "smtp")
            put("mail.smtp.host", account.host)
            put("mail.smtp.port", account.port.toString())
            put("mail.smtp.auth", "true")
            if (account.useStartTls) {
                put("mail.smtp.starttls.enable", "true")
                put("mail.smtp.starttls.required", "true")
            }
            // Same mechanism the spike proved for IMAP; token flows as the password.
            if (account.auth is SmtpAuth.XOAuth2) put("mail.smtp.auth.mechanisms", "XOAUTH2")
        }
        val session = Session.getInstance(props)

        val mime = MimeMessage(session)
        mime.setFrom(InternetAddress(account.fromAddress))
        mime.setRecipients(Message.RecipientType.TO, InternetAddress.parse(message.to))
        message.cc?.takeIf { it.isNotBlank() }
            ?.let { mime.setRecipients(Message.RecipientType.CC, InternetAddress.parse(it)) }
        message.bcc?.takeIf { it.isNotBlank() }
            ?.let { mime.setRecipients(Message.RecipientType.BCC, InternetAddress.parse(it)) }
        mime.setSubject(message.subject, "UTF-8")
        mime.setSentDate(sentDate)
        message.inReplyTo?.let { mime.setHeader("In-Reply-To", it) }
        message.references?.let { mime.setHeader("References", it) }
        message.userAgent?.let {
            mime.setHeader("User-Agent", it)
            mime.setHeader("X-Mailer", it)
        }
        setBody(mime, message)
        mime.saveChanges()

        val transport = session.getTransport("smtp")
        try {
            when (val auth = account.auth) {
                is SmtpAuth.XOAuth2 -> transport.connect(account.host, account.port, auth.email, auth.accessToken)
                is SmtpAuth.Password -> transport.connect(account.host, account.port, auth.username, auth.password)
            }
            transport.sendMessage(mime, mime.allRecipients)
        } finally {
            transport.close()
        }

        return ByteArrayOutputStream().use { mime.writeTo(it); it.toByteArray() }
    }

    /** text-only → text/plain; html present → multipart/alternative (text then html). */
    private fun setBody(mime: MimeMessage, message: OutgoingMessage) {
        val html = message.bodyHtml?.takeIf { it.isNotBlank() }
        if (html == null) {
            mime.setText(message.bodyText ?: "", "UTF-8")
            return
        }
        val alternative = MimeMultipart("alternative").apply {
            // Least-preferred (plain) first, richest (html) last — RFC 2046 §5.1.4.
            addBodyPart(MimeBodyPart().apply { setText(message.bodyText ?: "", "UTF-8") })
            addBodyPart(MimeBodyPart().apply { setContent(html, "text/html; charset=UTF-8") })
        }
        mime.setContent(alternative)
    }
}
