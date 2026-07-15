package orbit.auth

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * CSRF `state` parameter. The desktop loopback parsed `state` but never
 * validated it; on Android we generate a high-entropy value and check it on the
 * redirect (audit §5 flagged this gap). AppAuth also handles state internally —
 * this is the reference + fallback.
 */
object OAuthState {
    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()

    fun generate(random: SecureRandom = SecureRandom()): String {
        val bytes = ByteArray(32)
        random.nextBytes(bytes)
        return urlEncoder.encodeToString(bytes)
    }

    /** Constant-time comparison of the returned state against the one we sent. */
    fun isValid(expected: String, actual: String?): Boolean {
        if (actual == null) return false
        return MessageDigest.isEqual(
            expected.toByteArray(Charsets.US_ASCII),
            actual.toByteArray(Charsets.US_ASCII)
        )
    }
}
