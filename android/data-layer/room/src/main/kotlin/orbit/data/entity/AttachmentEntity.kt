package orbit.data.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/** Attachment metadata; [localPath] is null until the part is fetched on demand. */
@Entity(
    tableName = "attachments",
    foreignKeys = [
        ForeignKey(entity = MessageEntity::class, parentColumns = ["id"], childColumns = ["message_id"], onDelete = ForeignKey.CASCADE)
    ],
    indices = [Index(name = "attachments_message_idx", value = ["message_id"])]
)
data class AttachmentEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "message_id") val messageId: String,
    val filename: String,
    @ColumnInfo(name = "mime_type") val mimeType: String,
    val size: Long,
    @ColumnInfo(name = "local_path") val localPath: String? = null
)
