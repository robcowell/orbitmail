package orbit.data

import androidx.room.ColumnInfo

/** Lightweight row for the message list — no body blobs (audit §Performance). */
data class MessageSummary(
    val id: String,
    @ColumnInfo(name = "folder_id") val folderId: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    val uid: Long,
    @ColumnInfo(name = "message_id") val messageId: String?,
    @ColumnInfo(name = "from_addr") val from: String,
    @ColumnInfo(name = "to_addr") val to: String,
    val subject: String,
    val snippet: String,
    val date: Long,
    @ColumnInfo(name = "is_read") val isRead: Boolean,
    @ColumnInfo(name = "is_starred") val isStarred: Boolean,
    @ColumnInfo(name = "flag_color") val flagColor: FlagColor?,
    @ColumnInfo(name = "has_attachments") val hasAttachments: Boolean,
    @ColumnInfo(name = "thread_id") val threadId: String?
)

/** One collapsed conversation row (latest message + in-folder aggregates). */
data class ThreadSummaryRow(
    @ColumnInfo(name = "thread_id") val threadId: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "latest_message_id") val latestMessageId: String,
    @ColumnInfo(name = "from_addr") val from: String,
    val subject: String,
    val snippet: String,
    val date: Long,
    @ColumnInfo(name = "is_starred") val isStarred: Boolean,
    @ColumnInfo(name = "flag_color") val flagColor: FlagColor?,
    @ColumnInfo(name = "has_attachments") val hasAttachments: Boolean,
    @ColumnInfo(name = "msg_count") val messageCount: Int,
    @ColumnInfo(name = "has_unread") val hasUnread: Boolean
)

/** A single flag reconciliation update keyed by server UID. */
data class FlagUpdate(val uid: Long, val isRead: Boolean, val isStarred: Boolean)
