package orbit.auth.appauth

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import kotlinx.coroutines.suspendCancellableCoroutine
import net.openid.appauth.AuthState
import net.openid.appauth.AuthorizationException
import net.openid.appauth.AuthorizationRequest
import net.openid.appauth.AuthorizationResponse
import net.openid.appauth.AuthorizationService
import net.openid.appauth.AuthorizationServiceConfiguration
import net.openid.appauth.ResponseTypeValues
import orbit.auth.OAuthProviderConfig
import orbit.auth.TokenData
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * AppAuth-Android driver for Gmail + Microsoft OAuth (audit §5). AppAuth runs the
 * code+PKCE flow in a Chrome Custom Tab, handles the custom-scheme redirect, and
 * manages token exchange + refresh. This wrapper adapts it to the app's
 * [OAuthProviderConfig] + [TokenData] and persists AuthState via
 * [SecureCredentialStore].
 *
 * Replaces the entire Electron loopback-HTTP-server + shell.openExternal flow,
 * which has no Android equivalent (audit §5). The access token this yields is
 * fed straight into the Jakarta Mail XOAUTH2 connect proven by the IMAP spike.
 *
 * NOTE: builds in the Android app project only (needs the Android SDK + AppAuth
 * AAR from Google Maven). The provider-agnostic logic is verified in ../core.
 */
class AppAuthAuthenticator(
    private val context: Context,
    private val store: SecureCredentialStore
) {
    private val service = AuthorizationService(context)

    private fun serviceConfig(config: OAuthProviderConfig) = AuthorizationServiceConfiguration(
        Uri.parse(config.authorizationEndpoint),
        Uri.parse(config.tokenEndpoint)
    )

    /** Build the intent that launches the Custom Tab consent screen. */
    fun authorizationIntent(config: OAuthProviderConfig): Intent {
        val request = AuthorizationRequest.Builder(
            serviceConfig(config),
            config.clientId,
            ResponseTypeValues.CODE,
            Uri.parse(config.redirectUri)
        )
            .setScopes(config.scopes) // exact audited scopes
            .setAdditionalParameters(config.extraAuthParams) // access_type=offline, prompt, …
            .build() // AppAuth generates PKCE (S256) + state internally
        return service.getAuthorizationRequestIntent(request)
    }

    /**
     * Complete sign-in from the redirect [Intent] delivered to the calling
     * Activity: validate the response, exchange the code for tokens, persist the
     * AuthState, and return the [TokenData].
     */
    suspend fun onAuthorizationResult(config: OAuthProviderConfig, accountId: String, data: Intent): TokenData {
        val response = AuthorizationResponse.fromIntent(data)
        val error = AuthorizationException.fromIntent(data)
        if (response == null) throw error ?: IllegalStateException("No authorization response")

        val authState = AuthState(response, error)
        val tokenResponse = suspendCancellableCoroutine { cont ->
            service.performTokenRequest(response.createTokenExchangeRequest()) { resp, ex ->
                if (resp != null) cont.resume(resp) else cont.resumeWithException(ex ?: IllegalStateException("Token exchange failed"))
            }
        }
        authState.update(tokenResponse, null)
        store.saveAuthState(accountId, authState.jsonSerializeString())

        val tokens = TokenData(
            accessToken = tokenResponse.accessToken ?: error("No access token"),
            refreshToken = tokenResponse.refreshToken,
            expiryDate = tokenResponse.accessTokenExpirationTime,
            email = null,       // resolve via userinfo/id_token if a display email is needed
            displayName = null
        )
        store.saveTokens(accountId, tokens)
        return tokens
    }

    /**
     * A guaranteed-fresh access token for IMAP/SMTP XOAUTH2. AppAuth refreshes
     * only if needed (its own skew), rotating + re-persisting the AuthState.
     * Mirrors the desktop `ensureFreshToken` boundary before every connect.
     */
    suspend fun freshAccessToken(accountId: String): String {
        val serialized = store.loadAuthState(accountId) ?: error("No AuthState for $accountId — re-authenticate")
        val authState = AuthState.jsonDeserialize(serialized)
        return suspendCancellableCoroutine { cont ->
            authState.performActionWithFreshTokens(service) { accessToken, _, ex ->
                if (accessToken != null) {
                    store.saveAuthState(accountId, authState.jsonSerializeString()) // persist rotation
                    cont.resume(accessToken)
                } else {
                    cont.resumeWithException(ex ?: IllegalStateException("Token refresh failed"))
                }
            }
        }
    }

    fun dispose() = service.dispose()

    companion object {
        /** For reference: launch [authorizationIntent] via an ActivityResult contract. */
        const val RC_AUTH = 4001
        fun isRedirect(activity: Activity, uri: Uri, config: OAuthProviderConfig): Boolean =
            uri.toString().startsWith(config.redirectUri)
    }
}
