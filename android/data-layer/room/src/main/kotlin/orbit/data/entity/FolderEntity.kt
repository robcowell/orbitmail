package orbit.data.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey
import orbit.data.FolderType

@Entity(
    tableName = "folders",
    foreignKeys = [
        ForeignKey(
            entity = AccountEntity::class,
            parentColumns = ["id"],
            childColumns = ["account_id"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index(name = "folders_account_idx", value = ["account_id"])]
)
data class FolderEntity(
    @PrimaryKey val id: String,
    @ColumnInfo(name = "account_id") val accountId: String,
    @ColumnInfo(name = "imap_path") val imapPath: String,
    val name: String,
    val type: FolderType,
    @ColumnInfo(name = "unread_count", defaultValue = "0") val unreadCount: Int = 0,
    @ColumnInfo(name = "is_virtual_view", defaultValue = "0") val isVirtualView: Boolean = false,
    @ColumnInfo(name = "uid_validity") val uidValidity: Long? = null,
    @ColumnInfo(name = "highest_synced_uid", defaultValue = "0") val highestSyncedUid: Long = 0,
    @ColumnInfo(name = "last_sync_at") val lastSyncAt: Long? = null,
    @ColumnInfo(name = "initial_sync_complete", defaultValue = "0") val initialSyncComplete: Boolean = false,
    // 64-bit CONDSTORE MODSEQ stored as text (can exceed Long range on the wire).
    @ColumnInfo(name = "highest_modseq") val highestModseq: String? = null,
    @ColumnInfo(name = "server_message_count") val serverMessageCount: Int? = null
)
