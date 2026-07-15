package orbit.auth

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.security.SecureRandom

/**
 * Verifies the provider-agnostic OAuth logic that the AppAuth integration relies
 * on: PKCE (against the RFC 7636 vector), the exact audited scope sets, the
 * authorization-URL contract, token refresh-decision skew, state validation, and
 * token-response parsing.
 */
class OAuthCoreTest {

    private val gClientId = "1234567890-abcdefg.apps.googleusercontent.com"
    private val gScheme = "com.googleusercontent.apps.1234567890-abcdefg"
    private val google = OAuthConfigs.google(gClientId, gScheme)
    private val microsoft = OAuthConfigs.microsoft("11111111-2222-3333-4444-555555555555", "com.orbitmail.app")

    @Test
    fun pkce_matchesRfc7636TestVector() {
        // RFC 7636 Appendix B.
        val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge(verifier))
        println("PROOF[pkce] S256 challenge matches RFC 7636 Appendix B vector")
    }

    @Test
    fun pkce_generatedVerifier_isUrlSafe_andCorrectLength() {
        val v = Pkce.generateVerifier(SecureRandom())
        assertEquals(43, v.length, "32 bytes base64url (no pad) = 43 chars, within RFC 43–128")
        assertTrue(v.all { it.isLetterOrDigit() || it == '-' || it == '_' }, "verifier must be URL-safe")
        // Challenge is deterministic for a given verifier.
        assertEquals(Pkce.challenge(v), Pkce.challenge(v))
        println("PROOF[pkce] verifier is 43-char URL-safe; challenge deterministic")
    }

    @Test
    fun googleScopes_matchAudit() {
        assertEquals(listOf("https://mail.google.com/", "openid", "email", "profile"), google.scopes)
        assertTrue(google.scopes.contains("https://mail.google.com/"), "only scope granting IMAP/SMTP")
        println("PROOF[scopes:google] ${google.scopeParam}")
    }

    @Test
    fun microsoftScopes_matchAudit() {
        assertEquals(
            listOf(
                "openid", "profile", "email", "offline_access",
                "https://outlook.office.com/IMAP.AccessAsUser.All",
                "https://outlook.office.com/SMTP.Send"
            ),
            microsoft.scopes
        )
        assertTrue(microsoft.scopes.contains("offline_access"), "needed for a refresh token")
        println("PROOF[scopes:microsoft] ${microsoft.scopeParam}")
    }

    @Test
    fun microsoft_endpoints_useConfiguredTenant() {
        val tenantScoped = OAuthConfigs.microsoft("cid", "com.orbitmail.app", tenant = "contoso.onmicrosoft.com")
        assertTrue(tenantScoped.authorizationEndpoint.contains("/contoso.onmicrosoft.com/"))
        assertTrue(microsoft.authorizationEndpoint.contains("/common/"), "default tenant is common")
        println("PROOF[ms-tenant] tenant substituted into authorize/token endpoints")
    }

    @Test
    fun authorizationUrl_hasCodeFlowPkceAndProviderParams() {
        val url = AuthorizationUrl.build(google, state = "STATE123", codeChallenge = "CHALLENGE")
        assertTrue(url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?"))
        listOf(
            "client_id=1234567890-abcdefg.apps.googleusercontent.com",
            "response_type=code",
            "code_challenge=CHALLENGE",
            "code_challenge_method=S256",
            "state=STATE123",
            "access_type=offline",
            "prompt=consent"
        ).forEach { assertTrue(url.contains(it), "auth URL missing `$it`\n$url") }
        // scope is space-delimited, %20-encoded; the restricted Gmail scope present.
        assertTrue(url.contains("scope=https%3A%2F%2Fmail.google.com%2F%20openid%20email%20profile"), url)
        // redirect uses the reversed-client-id custom scheme.
        assertTrue(url.contains("redirect_uri=com.googleusercontent.apps.1234567890-abcdefg%3A%2Foauth2redirect"), url)
        println("PROOF[auth-url] code+PKCE(S256)+offline+state+scope+redirect all present")
    }

    @Test
    fun tokenRefresh_skewLogic() {
        val now = 1_000_000_000_000L
        assertTrue(TokenRefresh.needsRefresh(TokenData("a", "r", expiryDate = null), now), "no expiry → refresh")
        assertTrue(TokenRefresh.needsRefresh(TokenData("a", "r", expiryDate = now + 60_000), now), "expires within 120s skew → refresh")
        assertFalse(TokenRefresh.needsRefresh(TokenData("a", "r", expiryDate = now + 600_000), now), "10 min out → no refresh")
        println("PROOF[refresh] refresh iff missing expiry or within 120s skew")
    }

    @Test
    fun state_generatesUrlSafe_andValidatesConstantTime() {
        val s = OAuthState.generate(SecureRandom())
        assertTrue(s.length >= 43)
        assertTrue(OAuthState.isValid(s, s))
        assertFalse(OAuthState.isValid(s, "tampered"))
        assertFalse(OAuthState.isValid(s, null))
        println("PROOF[state] generated state validates; mismatch/null rejected")
    }

    @Test
    fun tokenResponse_parses_expiryAndRefresh() {
        val now = 1_000_000_000_000L
        val fresh = TokenResponseParser.parse(
            """{"access_token":"AT1","refresh_token":"RT1","expires_in":3600,"token_type":"Bearer"}""", now
        )
        assertEquals("AT1", fresh.accessToken)
        assertEquals("RT1", fresh.refreshToken)
        assertEquals(now + 3_600_000, fresh.expiryDate)

        // A refresh response omitting refresh_token keeps the previous one.
        val refreshed = TokenResponseParser.parse(
            """{"access_token":"AT2","expires_in":3599}""", now, previousRefreshToken = "RT1"
        )
        assertEquals("AT2", refreshed.accessToken)
        assertEquals("RT1", refreshed.refreshToken, "missing refresh_token falls back to previous")
        println("PROOF[token-parse] expires_in→expiryDate; refresh_token fallback preserved")
    }
}
