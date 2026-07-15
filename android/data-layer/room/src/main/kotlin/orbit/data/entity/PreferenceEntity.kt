package orbit.data.entity

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Generic key/value store (mirrors app_preferences). Holds the `app_state` JSON
 * blob, `ai_sweep_meta`, and one-time guards. NOTE: `ai_api_key` does NOT belong
 * here on Android — the Anthropic key goes to Keystore, not the DB (audit §6, §7).
 */
@Entity(tableName = "app_preferences")
data class PreferenceEntity(
    @PrimaryKey val key: String,
    val value: String
)
