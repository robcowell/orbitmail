package orbit.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow
import orbit.data.entity.AccountEntity

@Dao
interface AccountDao {
    @Query("SELECT * FROM accounts ORDER BY created_at ASC")
    fun observeAll(): Flow<List<AccountEntity>>

    @Query("SELECT * FROM accounts ORDER BY created_at ASC")
    suspend fun getAll(): List<AccountEntity>

    @Query("SELECT * FROM accounts WHERE id = :id")
    suspend fun getById(id: String): AccountEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(account: AccountEntity)

    @Query("UPDATE accounts SET display_name = :displayName WHERE id = :id")
    suspend fun updateDisplayName(id: String, displayName: String)

    @Query("UPDATE accounts SET sync_days = :syncDays WHERE id = :id")
    suspend fun updateSyncDays(id: String, syncDays: Int)

    // Cascades to folders → messages → attachments (FK ON DELETE CASCADE).
    @Query("DELETE FROM accounts WHERE id = :id")
    suspend fun delete(id: String)
}
