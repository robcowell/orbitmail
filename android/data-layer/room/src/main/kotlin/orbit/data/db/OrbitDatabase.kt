package orbit.data.db

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverters
import androidx.sqlite.db.SupportSQLiteDatabase
import orbit.data.Converters
import orbit.data.dao.AccountDao
import orbit.data.dao.AttachmentDao
import orbit.data.dao.FolderDao
import orbit.data.dao.MessageDao
import orbit.data.dao.PreferenceDao
import orbit.data.dao.SweepTaskDao
import orbit.data.entity.AccountEntity
import orbit.data.entity.AttachmentEntity
import orbit.data.entity.FolderEntity
import orbit.data.entity.MessageEntity
import orbit.data.entity.PreferenceEntity
import orbit.data.entity.SweepTaskEntity

@Database(
    entities = [
        AccountEntity::class,
        FolderEntity::class,
        MessageEntity::class,
        AttachmentEntity::class,
        PreferenceEntity::class,
        SweepTaskEntity::class
    ],
    version = 1,
    exportSchema = true
)
@TypeConverters(Converters::class)
abstract class OrbitDatabase : RoomDatabase() {
    abstract fun accountDao(): AccountDao
    abstract fun folderDao(): FolderDao
    abstract fun messageDao(): MessageDao
    abstract fun attachmentDao(): AttachmentDao
    abstract fun preferenceDao(): PreferenceDao
    abstract fun sweepTaskDao(): SweepTaskDao

    companion object {
        /**
         * The partial unread index cannot be expressed with a Room @Index
         * (Room has no WHERE clause), so it's created here on first open. Its
         * effectiveness is verified in ../schema-verify (EXPLAIN QUERY PLAN).
         */
        private val CALLBACK = object : Callback() {
            override fun onCreate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS messages_folder_unread_idx ON messages(folder_id) WHERE is_read = 0"
                )
            }
        }

        fun build(context: Context, name: String = "orbit-mail.db"): OrbitDatabase =
            Room.databaseBuilder(context, OrbitDatabase::class.java, name)
                // Foreign keys drive the delete cascades relied on by removeAccount.
                .addCallback(CALLBACK)
                .build()
    }
}
