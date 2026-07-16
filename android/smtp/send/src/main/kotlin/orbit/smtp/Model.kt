package orbit.smtp

/**
 * SMTP-send domain model — the send half of the desktop `smtp-send.ts` (its
 * reply/forward payload building is the pure `:ui:presentation` ReplyComposer).
 * Android-free so the sender runs against a real SMTP server (GreenMail) in tests.
 */

/** How the SMTP transport authenticates. Mirrors the sync engine's `Auth`. */
sealed interface SmtpAuth {
    /** OAuth XOAUTH2 — [accessToken] comes fresh from Step 3's freshAccessToken(). */
    data class XOAuth2(val email: String, val accessToken: String) : SmtpAuth
    data class Password(val username: String, val password: String) : SmtpAuth
}

/** Everything needed to open one authenticated SMTP submission connection. */
data class SmtpAccount(
    val host: String,
    val port: Int,
    val fromAddress: String,
    val auth: SmtpAuth,
    // Providers submit over STARTTLS on 587; GreenMail tests use plain SMTP.
    val useStartTls: Boolean = true
)

/**
 * A message to submit. [inReplyTo] / [references] carry the RFC 5322 threading
 * chain so replies group under the original conversation on the recipient side.
 */
data class OutgoingMessage(
    val to: String,
    val cc: String? = null,
    val bcc: String? = null,
    val subject: String,
    val bodyText: String? = null,
    val bodyHtml: String? = null,
    val inReplyTo: String? = null,
    val references: String? = null,
    // Written to the User-Agent / X-Mailer headers, mirroring the desktop mailer id.
    val userAgent: String? = null
)
