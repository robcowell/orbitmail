package orbit.auth

import org.json.JSONObject
import java.util.Base64

/**
 * Minimal OIDC id_token reader — pulls the display identity (email, name) from
 * the JWT payload so a signed-in account can be labelled. We do NOT verify the
 * signature: the token came straight from the provider's token endpoint over
 * TLS in this same flow, so it's trusted for display purposes only (never for
 * authorization). Pure Kotlin, verified off-device.
 */
object IdToken {

    /** (email, name) from the id_token's payload claims; nulls if absent/unparseable. */
    fun claims(idToken: String?): Claims {
        if (idToken.isNullOrBlank()) return Claims(null, null)
        val parts = idToken.split(".")
        if (parts.size < 2) return Claims(null, null)
        return try {
            val payload = String(Base64.getUrlDecoder().decode(parts[1]))
            val json = JSONObject(payload)
            Claims(
                email = json.optString("email").ifBlank { null },
                name = json.optString("name").ifBlank { null }
            )
        } catch (_: Exception) {
            Claims(null, null)
        }
    }

    data class Claims(val email: String?, val name: String?)
}
