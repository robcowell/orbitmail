package orbit.auth

/**
 * Provider-agnostic OAuth configuration. Pure Kotlin (no Android deps) so it is
 * shared by the AppAuth integration AND verified off-device. Scopes and
 * endpoints are the exact values from the Step 0 audit §5.
 */
data class OAuthProviderConfig(
    val id: String,                       // "google" | "microsoft"
    val clientId: String,                 // Android OAuth client id (build config)
    val authorizationEndpoint: String,
    val tokenEndpoint: String,
    val scopes: List<String>,
    val redirectScheme: String,           // registered custom scheme for the app
    val redirectPath: String = "/oauth2redirect",
    val extraAuthParams: Map<String, String> = emptyMap()
) {
    /** e.g. `com.orbitmail.app:/oauth2redirect` — captured by an intent-filter. */
    val redirectUri: String get() = "$redirectScheme:$redirectPath"

    /** Space-delimited scope string for the `scope` auth/token param. */
    val scopeParam: String get() = scopes.joinToString(" ")
}

object OAuthConfigs {

    // Gmail: the only scope granting IMAP/SMTP is the restricted mail.google.com.
    val GOOGLE_SCOPES = listOf("https://mail.google.com/", "openid", "email", "profile")

    // Microsoft: IMAP + SMTP delegated scopes, consented dynamically at sign-in.
    val MICROSOFT_SCOPES = listOf(
        "openid",
        "profile",
        "email",
        "offline_access",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send"
    )

    /**
     * Google (Gmail). [redirectScheme] is the app's reversed OAuth client id
     * (e.g. `com.googleusercontent.apps.1234-abc`) for an Android/installed-app
     * client — a PUBLIC client with PKCE and NO secret (audit §5).
     */
    fun google(clientId: String, redirectScheme: String) = OAuthProviderConfig(
        id = "google",
        clientId = clientId,
        authorizationEndpoint = "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint = "https://oauth2.googleapis.com/token",
        scopes = GOOGLE_SCOPES,
        redirectScheme = redirectScheme,
        // access_type=offline → refresh token; prompt=consent guarantees one on
        // re-auth; include_granted_scopes for incremental auth (mirrors desktop).
        extraAuthParams = mapOf(
            "access_type" to "offline",
            "prompt" to "consent",
            "include_granted_scopes" to "true"
        )
    )

    /**
     * Microsoft 365 / Outlook. Public client (no secret); [tenant] defaults to
     * `common`. [redirectScheme] is a custom scheme registered under the app's
     * "Mobile and desktop" platform in Entra.
     */
    fun microsoft(clientId: String, redirectScheme: String, tenant: String = "common") = OAuthProviderConfig(
        id = "microsoft",
        clientId = clientId,
        authorizationEndpoint = "https://login.microsoftonline.com/$tenant/oauth2/v2.0/authorize",
        tokenEndpoint = "https://login.microsoftonline.com/$tenant/oauth2/v2.0/token",
        scopes = MICROSOFT_SCOPES,
        redirectScheme = redirectScheme,
        extraAuthParams = mapOf("prompt" to "select_account")
    )
}
