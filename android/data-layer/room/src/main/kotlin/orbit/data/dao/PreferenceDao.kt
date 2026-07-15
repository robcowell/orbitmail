package orbit.data.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import kotlinx.coroutines.flow.Flow
import orbit.data.entity.PreferenceEntity

@Dao
interface PreferenceDao {
    @Query("SELECT value FROM app_preferences WHERE key = :key")
    suspend fun get(key: String): String?

    @Query("SELECT value FROM app_preferences WHERE key = :key")
    fun observe(key: String): Flow<String?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun put(pref: PreferenceEntity)

    @Query("DELETE FROM app_preferences WHERE key = :key")
    suspend fun delete(key: String)
}
