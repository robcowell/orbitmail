package orbit.sync

/**
 * Headless sync-engine domain model. Provider/type enums mirror the Step 2 Room
 * schema's wire values; the engine is UI- and Android-free so it runs against a
 * real IMAP server (GreenMail) in tests and plugs into the app via [MailRepository].
 */

enum class Provider(val wire: String) { GMAIL("gmail"), O365("o365"), IMAP("imap"), POP3("pop3") }

enum class FolderType(val wire: String) { INBOX("inbox"), SENT("sent"), DRAFTS("drafts"), TRASH("trash"), JUNK("junk"), CUSTOM("custom") }

/** How the engine authenticates a connection. */
sealed interface Auth {
    /** OAuth XOAUTH2 — [accessToken] comes fresh from Step 3's freshAccessToken(). */
    data class XOAuth2(val email: String, val accessToken: String) : Auth
    data class Password(val username: String, val password: String) : Auth
}

/** Everything needed to open an IMAP connection for one account. */
data class SyncAccount(
    val id: String,
    val provider: Provider,
    val host: String,
    val port: Int,
    val auth: Auth,
    val syncDays: Int = 90,
    // Real providers use implicit TLS on 993; GreenMail tests use plain IMAP.
    val useTls: Boolean = true
)

/** A mailbox as seen on the server (from LIST). */
data class RemoteFolder(
    val path: String,
    val name: String,
    val attributes: List<String> = emptyList(), // SPECIAL-USE etc. (\Sent, \Noselect…)
    val selectable: Boolean = true
)

/** Persisted per-folder sync cursor (subset of the Step 2 folders row). */
data class FolderState(
    val id: String,
    val accountId: String,
    val imapPath: String,
    val uidValidity: Long?,
    val highestSyncedUid: Long,
    val serverMessageCount: Int?
)

/** A parsed message ready to persist (maps to a Step 2 messages row). */
data class ParsedMessage(
    val folderId: String,
    val accountId: String,
    val uid: Long,
    val messageId: String?,
    val inReplyTo: String?,
    val references: String?,
    val threadId: String,
    val from: String,
    val to: String,
    val cc: String?,
    val subject: String,
    val snippet: String,
    val date: Long,
    val isRead: Boolean,
    val isStarred: Boolean,
    val hasAttachments: Boolean,
    val bodyText: String?,
    val bodyHtml: String?
)

/** One flag reconciliation delta keyed by server UID. */
data class FlagUpdate(val uid: Long, val isRead: Boolean, val isStarred: Boolean)

/** Result of syncing one folder. */
data class FolderSyncResult(val folderId: String, val newMessages: Int, val flagChanges: Int, val expunged: Int)
