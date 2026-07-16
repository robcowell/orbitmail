package orbit.mail

import android.content.Context
import android.os.Build
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import orbit.ai.AiResult
import orbit.ai.AiService
import orbit.ai.AnthropicClient
import orbit.auth.appauth.AppAuthAuthenticator
import orbit.bg.AccountSyncPref
import orbit.bg.SyncMode
import orbit.bg.service.BackgroundSyncOutcome
import orbit.bg.service.SyncManager
import orbit.data.Provider
import orbit.data.db.OrbitDatabase
import orbit.data.entity.AccountEntity
import orbit.mail.data.KeystoreApiKeyStore
import orbit.mail.data.KeystoreCredentialStore
import orbit.mail.data.RoomMailRepository
import orbit.mail.data.RoomMailUiRepository
import orbit.mail.data.ServerMutations
import orbit.smtp.OutgoingMessage
import orbit.smtp.SmtpAccount
import orbit.smtp.SmtpAuth
import orbit.smtp.SmtpSender
import orbit.sync.Auth
import orbit.sync.SyncAccount
import orbit.sync.SyncEngine
import orbit.sync.Provider as SyncProvider
import orbit.sync.imap.ImapMutations
import orbit.ui.ComposeDraft

/**
 * Manual DI graph — the single place the seven modules are composed. Deliberately
 * plain (no Hilt) so the wiring is legible: each port interface is satisfied by an
 * adapter, and the adapters are constructed here from the modules' entry points.
 *
 * Build-only on a dev machine (Android SDK + Google Maven). The interface fit is
 * the point: this file compiling proves the modules line up.
 */
private const val POLL_INTERVAL_MINUTES = 15

/** What the UI shell needs about the signed-in accounts. */
data class AccountsSnapshot(val primaryAccountId: String, val selfAddresses: Set<String>)

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

    // Reactive account snapshot for the UI shell: the primary account (the
    // send-from default until an account switcher exists) and every self-address
    // (for reply-all dedup). Updates as accounts are added/removed.
    val accountsSnapshot: Flow<AccountsSnapshot> = database.accountDao().observeAll().map { list ->
        AccountsSnapshot(
            primaryAccountId = list.firstOrNull()?.id ?: "",
            selfAddresses = list.mapNotNull { it.email.lowercase().ifBlank { null } }.toSet()
        )
    }

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

    // Sync refresh (:sync:engine) — provider IMAP endpoints (mirror desktop
    // PROVIDER_CONFIG.imap) and the data→sync provider mapping.
    private data class ImapEndpoint(val host: String, val port: Int)

    private fun imapEndpointFor(provider: Provider): ImapEndpoint = when (provider) {
        Provider.GMAIL -> ImapEndpoint("imap.gmail.com", 993)
        Provider.O365 -> ImapEndpoint("outlook.office365.com", 993)
        Provider.IMAP, Provider.POP3 -> error("Manual IMAP credentials are not stored on Android yet")
    }

    private fun toSyncProvider(provider: Provider): SyncProvider = when (provider) {
        Provider.GMAIL -> SyncProvider.GMAIL
        Provider.O365 -> SyncProvider.O365
        Provider.IMAP -> SyncProvider.IMAP
        Provider.POP3 -> SyncProvider.POP3
    }

    // Build a fresh-token SyncAccount for an OAuth account, or null for manual
    // (IMAP/POP3) accounts whose credentials aren't stored on Android yet.
    private suspend fun buildSyncAccount(account: AccountEntity): SyncAccount? {
        if (account.provider != Provider.GMAIL && account.provider != Provider.O365) return null
        val endpoint = imapEndpointFor(account.provider)
        return SyncAccount(
            id = account.id,
            provider = toSyncProvider(account.provider),
            host = endpoint.host,
            port = endpoint.port,
            auth = Auth.XOAuth2(account.email, authenticator.freshAccessToken(account.id)),
            syncDays = account.syncDays,
            useTls = true
        )
    }

    // Server write-path (:sync:engine ImapMutations) — the outbound counterpart to
    // syncEngine. Best-effort: failures are logged and left to self-heal on the
    // next sync (flag reconcile / re-import), never surfaced as UI errors.
    private val imapMutations = ImapMutations()

    private suspend fun runServerOp(accountId: String, folderId: String, op: (SyncAccount, String) -> Unit) {
        try {
            val account = database.accountDao().getById(accountId) ?: return
            val syncAccount = buildSyncAccount(account) ?: return
            val path = database.folderDao().getById(folderId)?.imapPath ?: return
            withContext(Dispatchers.IO) { op(syncAccount, path) }
        } catch (e: Exception) {
            Log.w("OrbitMail", "server mutation failed (self-heals on next sync)", e)
        }
    }

    private val serverMutations = object : ServerMutations {
        override suspend fun setSeen(accountId: String, folderId: String, uid: Long, isRead: Boolean) =
            runServerOp(accountId, folderId) { acc, path -> imapMutations.setSeen(acc, path, uid, isRead) }

        override suspend fun setFlagged(accountId: String, folderId: String, uid: Long, isFlagged: Boolean) =
            runServerOp(accountId, folderId) { acc, path -> imapMutations.setFlagged(acc, path, uid, isFlagged) }

        override suspend fun delete(accountId: String, folderId: String, uid: Long) =
            runServerOp(accountId, folderId) { acc, path -> imapMutations.delete(acc, path, uid) }

        override suspend fun move(accountId: String, folderId: String, uid: Long, targetFolderId: String) {
            val targetPath = database.folderDao().getById(targetFolderId)?.imapPath ?: return
            runServerOp(accountId, folderId) { acc, path -> imapMutations.move(acc, path, uid, targetPath) }
        }
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
        refresh = { accountId ->
            // null = refresh every account; otherwise just the one requested.
            // Manual (IMAP/POP3) accounts yield null and are skipped.
            val accounts =
                if (accountId != null) listOfNotNull(database.accountDao().getById(accountId))
                else database.accountDao().getAll()
            for (account in accounts) {
                val syncAccount = buildSyncAccount(account) ?: continue
                withContext(Dispatchers.IO) { syncEngine.syncAccount(syncAccount) }
            }
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
        },
        server = serverMutations
    )

    // Step 7 — AI, keyed off the Keystore API key.
    private val anthropic = AnthropicClient()
    val aiService = AiService { system, content, schema, maxTokens ->
        val key = apiKeyStore.get()
        if (key.isNullOrBlank()) AiResult.Err("Add an Anthropic API key in AI settings.")
        else anthropic.call(key, system, content, schema, maxTokens)
    }

    // ── Step 6 — background sync ─────────────────────────────────────────────
    // SyncSchedulePolicy makes the decisions (unit-tested in :background:policy);
    // these controllers are the execution layer. reconcile runs off the main
    // thread (prefsProvider reads accounts synchronously).
    private val appScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Default per-account mode until a sync-prefs UI exists: a 15-minute poll —
    // battery-friendly, no persistent notification. IDLE push is opt-in later.
    private fun defaultSyncPrefs(): List<AccountSyncPref> =
        database.accountDao().getAllSync().map { AccountSyncPref(it.id, SyncMode.Poll(POLL_INTERVAL_MINUTES)) }

    val syncManager = SyncManager(
        prefsProvider = ::defaultSyncPrefs,
        service = AndroidForegroundServiceController(context),
        work = WorkManagerScheduler(context)
    )

    /** Enqueue/refresh background sync per the policy. Safe to call on lifecycle. */
    fun reconcileBackgroundSync(appInForeground: Boolean) {
        appScope.launch { syncManager.reconcile(appInForeground) }
    }

    /** Sync every OAuth account, tallying new mail — used by the SyncWorker. */
    suspend fun runBackgroundSync(): BackgroundSyncOutcome {
        var newCount = 0
        var failed = false
        for (account in database.accountDao().getAll()) {
            val syncAccount = buildSyncAccount(account) ?: continue
            try {
                val results = withContext(Dispatchers.IO) { syncEngine.syncAccount(syncAccount) }
                newCount += results.sumOf { it.newMessages }
            } catch (e: Exception) {
                failed = true
                Log.w("OrbitMail", "background sync failed for ${account.id}", e)
            }
        }
        return BackgroundSyncOutcome(newCount, failed)
    }
}
