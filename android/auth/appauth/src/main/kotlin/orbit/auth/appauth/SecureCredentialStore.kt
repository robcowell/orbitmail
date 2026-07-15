package orbit.auth.appauth

import orbit.auth.TokenData

/**
 * Where OAuth tokens (and manual passwords) live on Android — the direct analog
 * of Electron `safeStorage`, and the reason `accounts` has no `token_blob`
 * column (audit §6). Keyed by account id.
 *
 * The production implementation is [EncryptedPrefsCredentialStore] below:
 * Android Keystore (hardware-backed AES key) + Jetpack Security
 * `EncryptedSharedPreferences`. IMPORTANT (audit §6): unlike the desktop, there
 * is NO plaintext fallback — Keystore is always available on Android.
 */
interface SecureCredentialStore {
    fun saveTokens(accountId: String, tokens: TokenData)
    fun loadTokens(accountId: String): TokenData?
    /** Persist AppAuth's serialized AuthState so refreshes survive process death. */
    fun saveAuthState(accountId: String, serializedAuthState: String)
    fun loadAuthState(accountId: String): String?
    fun clear(accountId: String)
}

/*
 * Reference implementation (kept as a comment so this file has no Android deps
 * and the module's structure stays readable; move to its own file in the app):
 *
 * class EncryptedPrefsCredentialStore(context: Context) : SecureCredentialStore {
 *     private val masterKey = MasterKey.Builder(context)
 *         .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)   // Android Keystore-backed
 *         .build()
 *     private val prefs = EncryptedSharedPreferences.create(
 *         context, "orbit_credentials", masterKey,
 *         EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
 *         EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
 *     )
 *     // saveTokens/loadTokens serialize TokenData as JSON into `prefs` under
 *     // "tokens:$accountId"; saveAuthState under "authstate:$accountId".
 * }
 */
