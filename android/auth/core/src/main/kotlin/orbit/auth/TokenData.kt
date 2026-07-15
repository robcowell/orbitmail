package orbit.auth

import org.json.JSONObject

/**
 * OAuth token bundle — the app-owned model persisted to the SecureCredentialStore
 * (Android Keystore + EncryptedSharedPreferences), NOT to Room (audit §6). Shape
 * mirrors the desktop `TokenData`.
 */
data class TokenData(
    val accessToken: String,
    val refreshToken: String?,
    val expiryDate: Long?,   // epoch millis, or null if the response omitted expires_in
    val email: String? = null,
    val displayName: String? = null
)

/** Refresh-decision logic (mirrors the desktop `ensureFreshToken`, 120s skew). */
object TokenRefresh {
    const val SKEW_MS: Long = 120_000

    /** True when the token is missing an expiry or expires within [skewMs] of [now]. */
    fun needsRefresh(token: TokenData, now: Long, skewMs: Long = SKEW_MS): Boolean {
        val expiry = token.expiryDate ?: return true
        return expiry < now + skewMs
    }
}

/**
 * Parses a token-endpoint JSON response into [TokenData]. AppAuth does this in
 * the real flow; kept as a verified reference + fallback. A refresh response may
 * omit `refresh_token`, in which case the caller keeps the prior one (Microsoft
 * rotates it, Google usually does not return a new one).
 */
object TokenResponseParser {
    fun parse(json: String, now: Long, previousRefreshToken: String? = null): TokenData {
        val o = JSONObject(json)
        val access = o.getString("access_token")
        val refresh = if (o.has("refresh_token")) o.getString("refresh_token") else previousRefreshToken
        val expiry = if (o.has("expires_in")) now + o.getLong("expires_in") * 1000 else null
        return TokenData(accessToken = access, refreshToken = refresh, expiryDate = expiry)
    }
}
