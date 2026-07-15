package orbit.ai

/**
 * Incremental sweep logic (audit §7) — the property that makes re-sweeping an
 * unchanged inbox cost zero tokens. Pure and unit-tested; the AiService wires the
 * model call in between.
 */
object SweepPlanner {

    /** Stable dedupe key: source message + normalized task text (first 120 chars). */
    fun dedupeKey(sourceMessageId: String, taskText: String): String {
        val normalized = taskText.lowercase().replace(Regex("\\s+"), " ").trim().take(120)
        return "$sourceMessageId::$normalized"
    }

    /** Only messages whose cache is null are sent to the model. */
    fun messagesToSend(messages: List<AiMessage>): List<AiMessage> =
        messages.filter { it.sweepCacheJson == null }

    /**
     * Merge cached extractions with freshly-returned tasks into the final open
     * list: dedupe by key, drop anything already completed. Returns the tasks and
     * the count freshly analyzed (0 ⇒ no API call was needed).
     */
    fun merge(
        cachedTasks: List<SweepTask>,
        freshTasks: List<SweepTask>,
        completed: List<CompletedTask>,
        freshCount: Int,
    ): List<SweepTask> {
        val completedKeys = completed.map { dedupeKey(it.task.sourceMessageId, it.task.task) }.toSet()
        val seen = HashSet<String>()
        return (cachedTasks + freshTasks).filter { t ->
            val key = dedupeKey(t.sourceMessageId, t.task)
            key !in completedKeys && seen.add(key)
        }
    }
}
