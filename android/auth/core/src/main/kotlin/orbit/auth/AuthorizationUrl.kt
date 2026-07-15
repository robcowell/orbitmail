package orbit.auth

import java.net.URLEncoder

/** Builds the authorization-request URL (code flow + PKCE) for a provider. */
object AuthorizationUrl {

    private fun enc(v: String): String = URLEncoder.encode(v, "UTF-8").replace("+", "%20")

    fun build(config: OAuthProviderConfig, state: String, codeChallenge: String): String {
        val params = LinkedHashMap<String, String>().apply {
            put("client_id", config.clientId)
            put("response_type", "code")
            put("redirect_uri", config.redirectUri)
            put("scope", config.scopeParam)
            put("state", state)
            put("code_challenge", codeChallenge)
            put("code_challenge_method", "S256")
            putAll(config.extraAuthParams)
        }
        val query = params.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }
        return "${config.authorizationEndpoint}?$query"
    }
}
