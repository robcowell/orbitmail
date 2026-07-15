package orbit.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import orbit.data.entity.SweepTaskEntity

@Dao
interface SweepTaskDao {
    @Query("SELECT * FROM sweep_tasks WHERE folder_id = :folderId AND status = 'open' ORDER BY created_at DESC")
    suspend fun listOpen(folderId: String): List<SweepTaskEntity>

    @Query("SELECT * FROM sweep_tasks WHERE folder_id = :folderId AND status = 'completed' ORDER BY completed_at DESC")
    suspend fun listCompleted(folderId: String): List<SweepTaskEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(tasks: List<SweepTaskEntity>)

    @Query("DELETE FROM sweep_tasks WHERE folder_id = :folderId AND status = 'open'")
    suspend fun deleteOpen(folderId: String)

    /** A fresh sweep replaces the OPEN rows; COMPLETED history is retained. */
    @Transaction
    suspend fun replaceOpen(folderId: String, tasks: List<SweepTaskEntity>) {
        deleteOpen(folderId)
        insertAll(tasks)
    }

    @Query("UPDATE sweep_tasks SET status = 'completed', completed_at = :at WHERE folder_id = :folderId AND id = :id")
    suspend fun complete(folderId: String, id: String, at: Long)

    @Query("UPDATE sweep_tasks SET status = 'open', completed_at = NULL WHERE folder_id = :folderId AND id = :id")
    suspend fun reopen(folderId: String, id: String)

    @Query("DELETE FROM sweep_tasks WHERE status = 'completed' AND completed_at < :cutoff")
    suspend fun pruneCompletedOlderThan(cutoff: Long)
}
