package orbit.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * PKCE (RFC 7636) — required for a public native OAuth client (audit §5). Both
 * Gmail and Microsoft on Android are public clients with no secret, so the
 * authorization-code flow must be PKCE-protected.
 *
 * AppAuth-Android performs PKCE internally; this implementation documents the
 * mechanism, is unit-verified against the RFC 7636 test vector, and is the
 * fallback for a non-AppAuth path.
 */
object Pkce {

    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()

    data class Pair(val verifier: String, val challenge: String, val method: String = "S256")

    /** Random high-entropy `code_verifier` (43 chars from 32 bytes, RFC range 43–128). */
    fun generateVerifier(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return urlEncoder.encodeToString(bytes)
    }

    /** `code_challenge = BASE64URL(SHA256(ASCII(verifier)))`, no padding. */
    fun challenge(verifier: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
        return urlEncoder.encodeToString(digest)
    }

    fun generate(random: SecureRandom = SecureRandom()): Pair {
        val verifier = generateVerifier(random)
        return Pair(verifier = verifier, challenge = challenge(verifier))
    }
}
