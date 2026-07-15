package orbit.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow
import orbit.data.entity.FolderEntity

@Dao
interface FolderDao {
    @Query("SELECT * FROM folders WHERE account_id = :accountId")
    fun observeByAccount(accountId: String): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders")
    fun observeAll(): Flow<List<FolderEntity>>

    @Query("SELECT * FROM folders WHERE account_id = :accountId")
    suspend fun listByAccount(accountId: String): List<FolderEntity>

    @Query("SELECT * FROM folders WHERE id = :id")
    suspend fun getById(id: String): FolderEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsert(folder: FolderEntity)

    @Query("UPDATE folders SET unread_count = :unread WHERE id = :id")
    suspend fun updateUnread(id: String, unread: Int)

    /** Persist post-fetch sync state (mirrors updateFolderSyncState). */
    @Query(
        """UPDATE folders SET uid_validity = :uidValidity, highest_synced_uid = :highestSyncedUid,
           last_sync_at = :lastSyncAt, initial_sync_complete = :initialSyncComplete WHERE id = :id"""
    )
    suspend fun updateSyncState(
        id: String, uidValidity: Long?, highestSyncedUid: Long, lastSyncAt: Long?, initialSyncComplete: Boolean
    )

    @Query("UPDATE folders SET highest_modseq = :modseq WHERE id = :id")
    suspend fun updateHighestModseq(id: String, modseq: String?)

    @Query("UPDATE folders SET server_message_count = :count WHERE id = :id")
    suspend fun updateServerMessageCount(id: String, count: Int?)

    @Query("SELECT uid_validity FROM folders WHERE id = :id")
    suspend fun getUidValidity(id: String): Long?

    /** Inbox folder ids for the unified view (excludes Gmail virtual views). */
    @Query("SELECT id FROM folders WHERE type = 'inbox' AND is_virtual_view = 0")
    suspend fun unifiedInboxFolderIds(): List<String>
}
