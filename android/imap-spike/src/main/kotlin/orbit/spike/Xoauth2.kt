package orbit.spike

import java.util.Base64

/**
 * XOAUTH2 (SASL) support for Gmail / Microsoft OAuth over IMAP + SMTP.
 *
 * KEY SPIKE FINDING — you do NOT hand-assemble the SASL string with Jakarta
 * Mail. The provider builds it internally when you:
 *
 *   1. set `mail.imap.auth.mechanisms=XOAUTH2` (or `mail.imaps.*`,
 *      `mail.smtp.auth.mechanisms=XOAUTH2`), and
 *   2. call `store.connect(host, userEmail, accessToken)` — i.e. pass the OAuth
 *      *access token* where the password normally goes.
 *
 * This mirrors how the Electron app works today: imapflow/nodemailer take a raw
 * `accessToken` and build XOAUTH2 for you. So the audit's worry ("might need
 * manual AUTH XOAUTH2 base64 assembly") is resolved: Jakarta Mail handles it.
 *
 * The manual builder below exists only so the spike can (a) unit-assert the wire
 * format and (b) serve as a fallback if a future library needs the raw string.
 */
object Xoauth2 {

    // Ctrl-A (0x01) — the SASL field separator used by the XOAUTH2 mechanism.
    private const val CTRL_A = '\u0001'

    /**
     * The exact SASL initial-client-response Gmail/Microsoft expect (pre-base64):
     * `user=<email>^Aauth=Bearer <token>^A^A`, where `^A` is Ctrl-A (0x01).
     */
    fun rawSaslToken(userEmail: String, accessToken: String): String =
        "user=$userEmail${CTRL_A}auth=Bearer $accessToken$CTRL_A$CTRL_A"

    /** Base64 of [rawSaslToken] — the argument to `AUTH XOAUTH2 <this>`. */
    fun base64SaslToken(userEmail: String, accessToken: String): String =
        Base64.getEncoder().encodeToString(rawSaslToken(userEmail, accessToken).toByteArray(Charsets.UTF_8))

    /**
     * IMAP session properties for XOAUTH2 over implicit TLS (port 993) — the
     * Gmail/O365 configuration. Pass the access token as the connect password.
     */
    fun imapXoauth2Props(host: String, port: Int = 993): java.util.Properties =
        java.util.Properties().apply {
            put("mail.store.protocol", "imaps")
            put("mail.imaps.host", host)
            put("mail.imaps.port", port.toString())
            put("mail.imaps.ssl.enable", "true")
            put("mail.imaps.auth.mechanisms", "XOAUTH2")
            // Keep false: this port uses the blocking folder.idle() on a dedicated
            // thread. Setting true forces the async IdleManager API and makes
            // folder.idle() throw "not supported with SocketChannels".
            put("mail.imaps.usesocketchannels", "false")
        }

    /** SMTP (STARTTLS on 587) properties for XOAUTH2 — the send path. */
    fun smtpXoauth2Props(host: String, port: Int = 587): java.util.Properties =
        java.util.Properties().apply {
            put("mail.transport.protocol", "smtp")
            put("mail.smtp.host", host)
            put("mail.smtp.port", port.toString())
            put("mail.smtp.auth", "true")
            put("mail.smtp.auth.mechanisms", "XOAUTH2")
            put("mail.smtp.starttls.enable", "true")
            put("mail.smtp.starttls.required", "true")
        }
}
