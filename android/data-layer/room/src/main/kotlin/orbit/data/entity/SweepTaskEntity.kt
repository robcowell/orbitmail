package orbit.data.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import orbit.data.AiPriority
import orbit.data.TaskStatus

/**
 * A persisted AI sweep task. Composite PK (folder_id, id) — `id` is a stable
 * dedupe key (source message + normalized task text). `folder_id` is a real
 * folder id or the literal 'unified'.
 */
@Entity(
    tableName = "sweep_tasks",
    primaryKeys = ["folder_id", "id"],
    indices = [Index(name = "sweep_tasks_folder_idx", value = ["folder_id"])]
)
data class SweepTaskEntity(
    @ColumnInfo(name = "folder_id") val folderId: String,
    val id: String,
    val task: String,
    val priority: AiPriority,
    @ColumnInfo(name = "source_message_id") val sourceMessageId: String,
    @ColumnInfo(name = "source_subject") val sourceSubject: String,
    @ColumnInfo(name = "source_from") val sourceFrom: String,
    @ColumnInfo(name = "status", defaultValue = "open") val status: TaskStatus = TaskStatus.OPEN,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "completed_at") val completedAt: Long? = null
)
