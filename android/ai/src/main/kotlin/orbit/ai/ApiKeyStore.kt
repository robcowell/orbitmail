package orbit.ai

/**
 * Where the Anthropic API key lives. On Android this is Keystore-backed
 * (EncryptedSharedPreferences) — NOT the Room DB (audit §6, §7): unlike the
 * desktop's `app_preferences.ai_api_key`, the key never touches the database.
 */
interface ApiKeyStore {
    fun get(): String?
    fun set(key: String)
    fun clear()
    fun isConfigured(): Boolean = !get().isNullOrBlank()
}
