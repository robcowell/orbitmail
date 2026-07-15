package orbit.ui

/**
 * Immutable UI models the Compose layer renders. Deliberately independent of the
 * Room entities / sync models — a mapping layer (in the app) projects those into
 * these. Keeping them here makes the presentation logic pure and unit-testable.
 */

enum class FlagColor { RED, ORANGE, YELLOW, GREEN, BLUE, PURPLE, GRAY }

enum class ComposeMode { NEW, REPLY, REPLY_ALL, FORWARD }

/** A flat message row in the list. */
data class MessageRow(
    val id: String,
    val threadId: String?,
    val from: String,
    val subject: String,
    val snippet: String,
    val date: Long,
    val isRead: Boolean,
    val isStarred: Boolean,
    val flagColor: FlagColor? = null,
    val hasAttachments: Boolean = false
)

/** A collapsed conversation row. */
data class ThreadRow(
    val threadId: String,
    val latestMessageId: String,
    val participants: List<String>,
    val subject: String,
    val snippet: String,
    val date: Long,
    val messageCount: Int,
    val hasUnread: Boolean,
    val isStarred: Boolean,
    val flagColor: FlagColor? = null,
    val hasAttachments: Boolean = false
)

/** Full message content for the reader / as a reply source. */
data class MessageContent(
    val id: String,
    val messageId: String?,
    val references: String?,
    val from: String,
    val to: String,
    val cc: String?,
    val subject: String,
    val date: Long,
    val bodyText: String?,
    val bodyHtml: String?
)

/** A composer draft (maps to the app's ComposePayload / SMTP send). */
data class ComposeDraft(
    val to: String = "",
    val cc: String = "",
    val bcc: String = "",
    val subject: String = "",
    val bodyText: String = "",
    val bodyHtml: String = "",
    val quotedText: String? = null,
    val quotedHtml: String? = null,
    val inReplyTo: String? = null,
    val references: String? = null,
    val mode: ComposeMode = ComposeMode.NEW,
    val originalMessageId: String? = null
)

enum class SearchField { ALL, FROM, TO, SUBJECT, BODY }
