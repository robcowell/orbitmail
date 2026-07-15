package orbit.spike

/**
 * CLI entry for the manual (Layer 3) parts of the spike. The automated proof is
 * `gradle test` (Layer 2, GreenMail). This runner is for pointing at a real
 * account.
 *
 *   gradle run --args="gmail"   # live IMAP capability probe (needs IMAP_* env)
 *   gradle run --args="sasl"    # print the XOAUTH2 base64 SASL token (debug)
 */
fun main(args: Array<String>) {
    when (args.firstOrNull()) {
        "gmail", "imap", "live" -> RealGmailSpike.run()
        "sasl" -> {
            val user = System.getenv("IMAP_USER") ?: error("Set IMAP_USER")
            val token = System.getenv("IMAP_ACCESS_TOKEN") ?: error("Set IMAP_ACCESS_TOKEN")
            println(Xoauth2.base64SaslToken(user, token))
        }
        else -> println(
            """
            Orbit Mail — IMAP library spike runner

            Automated proof (runs here, no credentials needed):
              gradle test

            Live proof (point at a real account):
              IMAP_USER=you@gmail.com IMAP_ACCESS_TOKEN=ya29... gradle run --args="gmail"
              IMAP_USER=you@gmail.com IMAP_PASSWORD=<app-pw> IMAP_AUTH=password gradle run --args="gmail"

            Debug:
              IMAP_USER=... IMAP_ACCESS_TOKEN=... gradle run --args="sasl"
            """.trimIndent()
        )
    }
}
