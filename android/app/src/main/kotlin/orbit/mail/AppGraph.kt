package orbit.mail

import android.content.Context
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import orbit.ai.AiResult
import orbit.ai.AiService
import orbit.ai.AnthropicClient
import orbit.auth.appauth.AppAuthAuthenticator
import orbit.data.Provider
import orbit.data.db.OrbitDatabase
import orbit.mail.data.KeystoreApiKeyStore
import orbit.mail.data.KeystoreCredentialStore
import orbit.mail.data.RoomMailRepository
import orbit.mail.data.RoomMailUiRepository
import orbit.smtp.OutgoingMessage
import orbit.smtp.SmtpAccount
import orbit.smtp.SmtpAuth
import orbit.smtp.SmtpSender
import orbit.sync.SyncEngine
import orbit.ui.ComposeDraft

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

    // SMTP send (:smtp:send) — mailer identity + provider endpoints, mirroring
    // the desktop smtp-send.ts mailerIdentity() / PROVIDER_CONFIG.
    private val mailerId = "Orbit Mail ${BuildConfig.VERSION_NAME} (Android ${Build.VERSION.RELEASE})"

    private data class SmtpEndpoint(val host: String, val port: Int)

    private fun smtpEndpointFor(provider: Provider): SmtpEndpoint = when (provider) {
        Provider.GMAIL -> SmtpEndpoint("smtp.gmail.com", 587)
        Provider.O365 -> SmtpEndpoint("smtp.office365.com", 587)
        // Manual (IMAP/POP3) SMTP settings aren't stored on Android yet.
        Provider.IMAP, Provider.POP3 -> error("Manual SMTP credentials are not stored on Android yet")
    }

    // Final wire body = the user's text/html followed by the collapsed reply quote
    // (the composer keeps them separate; see :ui:presentation ReplyComposer).
    private fun mergedText(d: ComposeDraft): String =
        listOfNotNull(d.bodyText.ifBlank { null }, d.quotedText).joinToString("\n\n")

    private fun mergedHtml(d: ComposeDraft): String? =
        listOfNotNull(d.bodyHtml.ifBlank { null }, d.quotedHtml).joinToString("\n").ifBlank { null }

    // Step 5 — the UI repository the ViewModels depend on.
    val mailUiRepository = RoomMailUiRepository(
        messageDao = database.messageDao(),
        refresh = { _ ->
            // TODO: for each stored account, build a SyncAccount (host/port +
            // Auth.XOAuth2(authenticator.freshAccessToken(id))) and run
            // syncEngine.syncAccount(...) on Dispatchers.IO.
        },
        sendMail = { draft, accountId ->
            withContext(Dispatchers.IO) {
                val account = database.accountDao().getById(accountId)
                    ?: error("Account $accountId not found")
                val endpoint = smtpEndpointFor(account.provider)
                val auth = SmtpAuth.XOAuth2(account.email, authenticator.freshAccessToken(accountId))
                SmtpSender.send(
                    SmtpAccount(endpoint.host, endpoint.port, account.email, auth),
                    OutgoingMessage(
                        to = draft.to,
                        cc = draft.cc.ifBlank { null },
                        bcc = draft.bcc.ifBlank { null },
                        subject = draft.subject,
                        bodyText = mergedText(draft),
                        bodyHtml = mergedHtml(draft),
                        inReplyTo = draft.inReplyTo,
                        references = draft.references,
                        userAgent = mailerId
                    )
                )
                Unit
            }
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
