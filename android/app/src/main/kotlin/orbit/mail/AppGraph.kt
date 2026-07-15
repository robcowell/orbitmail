package orbit.mail

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import orbit.ai.AiResult
import orbit.ai.AiService
import orbit.ai.AnthropicClient
import orbit.auth.appauth.AppAuthAuthenticator
import orbit.data.db.OrbitDatabase
import orbit.mail.data.KeystoreApiKeyStore
import orbit.mail.data.KeystoreCredentialStore
import orbit.mail.data.RoomMailRepository
import orbit.mail.data.RoomMailUiRepository
import orbit.sync.SyncEngine

/**
 * Manual DI graph — the single place the seven modules are composed. Deliberately
 * plain (no Hilt) so the wiring is legible: each port interface is satisfied by an
 * adapter, and the adapters are constructed here from the modules' entry points.
 *
 * Build-only on a dev machine (Android SDK + Google Maven). The interface fit is
 * the point: this file compiling proves the modules line up.
 */
class AppGraph(context: Context) {

    // Step 2 — Room database (credential-free).
    val database: OrbitDatabase = OrbitDatabase.build(context)

    // Steps 3 & 7 — Keystore-backed secret storage (never the DB).
    private val securePrefs = run {
        val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
        EncryptedSharedPreferences.create(
            context, "orbit_secure", masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }
    val apiKeyStore = KeystoreApiKeyStore(securePrefs)
    val credentialStore = KeystoreCredentialStore(securePrefs)

    // Step 3 — OAuth (AppAuth), tokens persisted via the credential store.
    val authenticator = AppAuthAuthenticator(context, credentialStore)

    // Step 4 — sync engine over the Room-backed MailRepository adapter.
    private val mailRepository = RoomMailRepository(database.folderDao(), database.messageDao())
    val syncEngine = SyncEngine(mailRepository)

    // Step 5 — the UI repository the ViewModels depend on.
    val mailUiRepository = RoomMailUiRepository(
        messageDao = database.messageDao(),
        refresh = { _ ->
            // TODO: for each stored account, build a SyncAccount (host/port +
            // Auth.XOAuth2(authenticator.freshAccessToken(id))) and run
            // syncEngine.syncAccount(...) on Dispatchers.IO.
        },
        sendMail = { _, _ ->
            // TODO: SMTP send via Jakarta Mail Transport with XOAUTH2 (audit §SMTP)
            // — the one desktop service not yet ported to its own module.
        }
    )

    // Step 7 — AI, keyed off the Keystore API key.
    private val anthropic = AnthropicClient()
    val aiService = AiService { system, content, schema, maxTokens ->
        val key = apiKeyStore.get()
        if (key.isNullOrBlank()) AiResult.Err("Add an Anthropic API key in AI settings.")
        else anthropic.call(key, system, content, schema, maxTokens)
    }

    // Step 6 — background sync is executed from OrbitApplication / a SyncManager
    // wired to the ForegroundServiceController + WorkScheduler controllers.
    // (SyncSchedulePolicy decisions are already unit-tested in :background:policy.)
}
