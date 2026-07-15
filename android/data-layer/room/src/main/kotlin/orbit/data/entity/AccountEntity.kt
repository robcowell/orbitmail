package orbit.data.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey
import orbit.data.Provider

/**
 * An account. NOTE (audit §2, §6): there is deliberately NO `token_blob` column.
 * OAuth tokens / manual passwords live in Android Keystore +
 * EncryptedSharedPreferences (a separate SecureCredentialStore keyed by [id]),
 * keeping the database credential-free.
 */
@Entity(tableName = "accounts")
data class AccountEntity(
    @PrimaryKey val id: String,
    val provider: Provider,
    val email: String,
    @ColumnInfo(name = "display_name") val displayName: String,
    @ColumnInfo(name = "created_at") val createdAt: Long,
    @ColumnInfo(name = "sync_days", defaultValue = "90") val syncDays: Int = 90
)
