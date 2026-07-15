package orbit.mail.data

import android.content.SharedPreferences
import org.json.JSONObject
import orbit.ai.ApiKeyStore
import orbit.auth.TokenData
import orbit.auth.appauth.SecureCredentialStore

/**
 * Keystore-backed implementations of the AI (Step 7) and auth (Step 3) key/token
 * stores. Both are constructed over an `EncryptedSharedPreferences` (Android
 * Keystore master key) — see [orbit.mail.AppGraph]. This is why neither the API
 * key nor the OAuth tokens ever touch the Room DB (audit §6/§7).
 */

class KeystoreApiKeyStore(private val prefs: SharedPreferences) : ApiKeyStore {
    override fun get(): String? = prefs.getString(KEY, null)
    override fun set(key: String) = prefs.edit().putString(KEY, key.trim()).apply()
    override fun clear() = prefs.edit().remove(KEY).apply()

    private companion object { const val KEY = "ai_api_key" }
}

class KeystoreCredentialStore(private val prefs: SharedPreferences) : SecureCredentialStore {

    override fun saveTokens(accountId: String, tokens: TokenData) {
        val json = JSONObject()
            .put("accessToken", tokens.accessToken)
            .put("refreshToken", tokens.refreshToken)
            .put("expiryDate", tokens.expiryDate)
            .put("email", tokens.email)
            .put("displayName", tokens.displayName)
        prefs.edit().putString(tokenKey(accountId), json.toString()).apply()
    }

    override fun loadTokens(accountId: String): TokenData? {
        val raw = prefs.getString(tokenKey(accountId), null) ?: return null
        val o = JSONObject(raw)
        return TokenData(
            accessToken = o.getString("accessToken"),
            refreshToken = o.optString("refreshToken").ifBlank { null },
            expiryDate = if (o.isNull("expiryDate")) null else o.optLong("expiryDate"),
            email = o.optString("email").ifBlank { null },
            displayName = o.optString("displayName").ifBlank { null }
        )
    }

    override fun saveAuthState(accountId: String, serializedAuthState: String) =
        prefs.edit().putString(authStateKey(accountId), serializedAuthState).apply()

    override fun loadAuthState(accountId: String): String? = prefs.getString(authStateKey(accountId), null)

    override fun clear(accountId: String) =
        prefs.edit().remove(tokenKey(accountId)).remove(authStateKey(accountId)).apply()

    private fun tokenKey(id: String) = "tokens:$id"
    private fun authStateKey(id: String) = "authstate:$id"
}
