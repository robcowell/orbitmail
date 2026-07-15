package orbit.ai

import org.json.JSONArray
import org.json.JSONObject

/**
 * Ties prompts + schemas + the model call + response parsing into the three
 * features (audit §7). The model call is injected as [invoke] so the whole
 * orchestration — including the incremental sweep — is unit-tested with a fake,
 * no network. The app binds [invoke] to `AnthropicClient.call` with the API key.
 */
class AiService(
    private val invoke: (system: String, content: JSONArray, schema: JSONObject, maxTokens: Int) -> AiResult<JSONObject>
) {
    data class SweepOutcome(val result: SweepResult, val cacheUpdates: Map<String, String>)

    // ── analyze ────────────────────────────────────────────────────────────────

    fun analyze(msg: AiMessage, selfEmails: Set<String>, now: Long): AiResult<AiAnalysis> {
        val content = AnthropicApi.textContent(Prompts.analyzeUser(msg, selfEmails))
        return when (val r = invoke(Prompts.ANALYZE_SYSTEM, content, Schemas.ANALYZE, 2048)) {
            is AiResult.Err -> r
            is AiResult.Ok -> AiResult.Ok(parseAnalysis(r.value, now))
        }
    }

    fun parseAnalysis(o: JSONObject, now: Long): AiAnalysis = AiAnalysis(
        summary = o.optString("summary"),
        actionItems = stringList(o.optJSONArray("actionItems")),
        questions = stringList(o.optJSONArray("questions")),
        keyContext = stringList(o.optJSONArray("keyContext")),
        generatedAt = now,
        cached = false
    )

    // ── draft reply ──────────────────────────────────────────────────────────────

    fun draftReply(thread: List<AiMessage>, userName: String, tone: DraftTone, selfEmails: Set<String>): AiResult<ReplyDraft> {
        val content = AnthropicApi.textContent(Prompts.draftUser(thread, selfEmails))
        return when (val r = invoke(Prompts.draftSystem(userName, tone), content, Schemas.DRAFT, 2048)) {
            is AiResult.Err -> r
            is AiResult.Ok -> AiResult.Ok(ReplyDraft(r.value.optString("reply")))
        }
    }

    // ── tasks sweep (incremental) ─────────────────────────────────────────────────

    fun sweep(messages: List<AiMessage>, completed: List<CompletedTask>, scope: SweepScope, now: Long): AiResult<SweepOutcome> {
        val byId = messages.associateBy { it.id }
        val cachedTasks = messages.flatMap { m -> parseCache(m.sweepCacheJson, m) }
        val toSend = SweepPlanner.messagesToSend(messages)

        // Nothing new to analyze → serve entirely from cache, spend no tokens.
        if (toSend.isEmpty()) {
            val merged = SweepPlanner.merge(cachedTasks, emptyList(), completed, freshCount = 0)
            return AiResult.Ok(SweepOutcome(SweepResult(merged, completed, messages.size, 0, scope, now), emptyMap()))
        }

        val content = AnthropicApi.textContent(Prompts.sweepUser(toSend, emptySet()))
        return when (val r = invoke(Prompts.sweepSystem(completed), content, Schemas.SWEEP, 4096)) {
            is AiResult.Err -> r
            is AiResult.Ok -> {
                val freshRaw = r.value.optJSONArray("tasks") ?: JSONArray()
                val freshTasks = ArrayList<SweepTask>()
                // Per-message cache: JSON array of {task, priority} for every sent message
                // (empty array ⇒ "analyzed, no tasks", so it isn't re-sent next time).
                val cacheArrays = toSend.associate { it.id to JSONArray() }
                for (i in 0 until freshRaw.length()) {
                    val t = freshRaw.optJSONObject(i) ?: continue
                    val srcId = t.optString("sourceMessageId")
                    val text = t.optString("task")
                    val priority = runCatching { AiPriority.from(t.optString("priority")) }.getOrDefault(AiPriority.MEDIUM)
                    val src = byId[srcId] ?: continue
                    freshTasks += SweepTask(
                        id = SweepPlanner.dedupeKey(srcId, text),
                        task = text, priority = priority,
                        sourceMessageId = srcId, sourceSubject = src.subject, sourceFrom = src.from
                    )
                    cacheArrays[srcId]?.put(JSONObject().put("task", text).put("priority", priority.wire))
                }
                val merged = SweepPlanner.merge(cachedTasks, freshTasks, completed, toSend.size)
                val cacheUpdates = cacheArrays.mapValues { it.value.toString() }
                AiResult.Ok(SweepOutcome(SweepResult(merged, completed, messages.size, toSend.size, scope, now), cacheUpdates))
            }
        }
    }

    private fun parseCache(json: String?, msg: AiMessage): List<SweepTask> {
        if (json == null) return emptyList()
        val arr = runCatching { JSONArray(json) }.getOrNull() ?: return emptyList()
        return (0 until arr.length()).mapNotNull { i ->
            val t = arr.optJSONObject(i) ?: return@mapNotNull null
            val text = t.optString("task")
            val priority = runCatching { AiPriority.from(t.optString("priority")) }.getOrDefault(AiPriority.MEDIUM)
            SweepTask(SweepPlanner.dedupeKey(msg.id, text), text, priority, msg.id, msg.subject, msg.from)
        }
    }

    private fun stringList(arr: JSONArray?): List<String> =
        if (arr == null) emptyList() else (0 until arr.length()).map { arr.optString(it) }
}
