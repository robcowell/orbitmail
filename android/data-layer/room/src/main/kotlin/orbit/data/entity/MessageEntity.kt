package orbit.data.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import orbit.data.FlagColor

/**
 * A cached message. Indices mirror the audited schema (verified in
 * ../schema-verify). The partial unread index `messages_folder_unread_idx`
 * (WHERE is_read = 0) is NOT expressible as a Room @Index and is created in
 * OrbitDatabase's onCreate callback.
 */
@Entity(
    tableName = "messages",
    foreignKeys = [
        ForeignKey(entity = FolderEntity::class, parentColumns = ["id"], childColumns = ["folder_id"], onDelete = ForeignKey.CASCADE),
        ForeignKey(entity = AccountEntity::class, parentColumns = ["id"], childColumns = ["account_id"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [
        Index(name = "messages_folder_date_idx", value = ["folder_id", "date"]),
        Index(name = "messages_account_date_idx", value = ["account_id", "date"]),
        Index(name = "messages_thread_idx", value = ["account_id", "thread_id"]),
        Index(name = "messages_message_id_idx", value = ["message_id"]),
        Index(name = "messages_folder_uid_idx", value = ["folder_id", "uid"], unique = true)
    ]
)
data class MessageEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "folder_id") val folderId: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    val uid: Long,
    @ColumnInfo(name = "message_id") val messageId: String? = null,
    @ColumnInfo(name = "in_reply_to") val inReplyTo: String? = null,
    // "references" is a SQL keyword; Room quotes the identifier automatically.
    @ColumnInfo(name = "references") val references: String? = null,
    @ColumnInfo(name = "thread_id") val threadId: String? = null,
    @ColumnInfo(name = "from_addr") val from: String,
    @ColumnInfo(name = "to_addr") val to: String,
    val cc: String? = null,
    val subject: String,
    val snippet: String,
    val date: Long,
    @ColumnInfo(name = "is_read", defaultValue = "0") val isRead: Boolean = false,
    @ColumnInfo(name = "is_starred", defaultValue = "0") val isStarred: Boolean = false,
    @ColumnInfo(name = "flag_color") val flagColor: FlagColor? = null,
    @ColumnInfo(name = "has_attachments", defaultValue = "0") val hasAttachments: Boolean = false,
    @ColumnInfo(name = "body_html") val bodyHtml: String? = null,
    @ColumnInfo(name = "body_text") val bodyText: String? = null,
    @ColumnInfo(name = "ai_analysis") val aiAnalysis: String? = null,
    @ColumnInfo(name = "ai_analysis_at") val aiAnalysisAt: Long? = null,
    @ColumnInfo(name = "sweep_cache") val sweepCache: String? = null,
    @ColumnInfo(name = "sweep_cache_at") val sweepCacheAt: Long? = null
)
