package orbit.ai

/** AI feature models — ported from the desktop `shared/types.ts` (audit §7). */

enum class AiPriority(val wire: String) {
    URGENT("urgent"), HIGH("high"), MEDIUM("medium"), LOW("low");
    companion object { fun from(v: String) = entries.first { it.wire == v } }
}

enum class DraftTone { BRIEF, NEUTRAL, DETAILED }

enum class SweepScope { UNREAD, ALL }

data class AiAnalysis(
    val summary: String,
    val actionItems: List<String>,
    val questions: List<String>,
    val keyContext: List<String>,
    val generatedAt: Long,
    val cached: Boolean,
    /** Attachments requested but not sendable (type/size) — transient. */
    val skippedAttachments: List<String> = emptyList()
)

data class ReplyDraft(val bodyText: String)

data class SweepTask(
    /** Stable dedupe key: source message + normalized task text. */
    val id: String,
    val task: String,
    val priority: AiPriority,
    val sourceMessageId: String,
    val sourceSubject: String,
    val sourceFrom: String
)

data class CompletedTask(val task: SweepTask, val completedAt: Long)

data class SweepResult(
    val tasks: List<SweepTask>,
    val completed: List<CompletedTask>,
    val analyzedCount: Int,
    /** Messages freshly sent to the model this sweep (rest served from cache). 0 = no tokens spent. */
    val freshCount: Int,
    val scope: SweepScope,
    val sweptAt: Long?
)

/** A message the AI features operate on (projected from the Step 2 row + account context). */
data class AiMessage(
    val id: String,
    val from: String,
    val to: String,
    val subject: String,
    val date: Long,
    val bodyText: String?,
    val bodyHtml: String?,
    /** Cached sweep extraction JSON, or null if never analyzed (drives incremental sweep). */
    val sweepCacheJson: String? = null
)

/** Result wrapper so callers distinguish success from a user-facing error. */
sealed interface AiResult<out T> {
    data class Ok<T>(val value: T) : AiResult<T>
    data class Err(val message: String) : AiResult<Nothing>
}
