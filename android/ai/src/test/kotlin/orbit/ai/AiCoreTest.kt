package orbit.ai

import org.json.JSONArray
import org.json.JSONObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AiCoreTest {

    private fun msg(id: String, from: String = "boss@x", subject: String = "s", body: String = "b", cache: String? = null) =
        AiMessage(id = id, from = from, to = "me@x", subject = subject, date = 0, bodyText = body, bodyHtml = null, sweepCacheJson = cache)

    private val now = 1_700_000_000_000L
    private val self = setOf("me@x")

    // ── prompts ────────────────────────────────────────────────────────────────

    @Test
    fun analyzePrompt_marksSenderDirection_andTruncatesBody() {
        val toYou = Prompts.analyzeUser(msg("m1", from = "boss@x"), self)
        assertTrue(toYou.contains("sent TO you"))
        val byYou = Prompts.analyzeUser(msg("m2", from = "me@x"), self)
        assertTrue(byYou.contains("sent BY you"))
        val long = Prompts.analyzeUser(msg("m3", body = "x".repeat(20_000)), self)
        assertTrue(long.length < 20_000 + 500, "body truncated to ~${Prompts.MAX_BODY_CHARS}")
        println("PROOF[prompt] analyze marks TO/BY-you direction; body truncated")
    }

    @Test
    fun stripHtml_removesTagsAndScripts() {
        assertEquals("Hello world", Prompts.stripHtml("<p>Hello <b>world</b></p><script>evil()</script>"))
    }

    // ── schemas ────────────────────────────────────────────────────────────────

    @Test
    fun schemas_areStructuredOutputCompliant() {
        for (s in listOf(Schemas.ANALYZE, Schemas.DRAFT, Schemas.SWEEP)) {
            assertEquals("object", s.getString("type"))
            assertFalse(s.getBoolean("additionalProperties"), "additionalProperties must be false")
            assertTrue(s.has("required"))
        }
        val taskItem = Schemas.SWEEP.getJSONObject("properties").getJSONObject("tasks").getJSONObject("items")
        assertFalse(taskItem.getBoolean("additionalProperties"))
        val enum = taskItem.getJSONObject("properties").getJSONObject("priority").getJSONArray("enum")
        assertEquals(listOf("urgent", "high", "medium", "low"), (0 until enum.length()).map { enum.getString(it) })
        println("PROOF[schema] all objects additionalProperties:false + required; priority enum correct")
    }

    // ── request building ─────────────────────────────────────────────────────────

    @Test
    fun requestBody_hasModelEffortAndStructuredFormat() {
        val body = AnthropicApi.buildRequestBody("sys", AnthropicApi.textContent("hi"), Schemas.DRAFT, 2048)
        assertEquals("claude-opus-4-8", body.getString("model"))
        assertEquals(2048, body.getInt("max_tokens"))
        assertEquals("sys", body.getString("system"))
        val oc = body.getJSONObject("output_config")
        assertEquals("low", oc.getString("effort"))
        assertEquals("json_schema", oc.getJSONObject("format").getString("type"))
        assertTrue(oc.getJSONObject("format").has("schema"))
        assertEquals("user", body.getJSONArray("messages").getJSONObject(0).getString("role"))
        println("PROOF[request] model=claude-opus-4-8, effort=low, output_config.format=json_schema")
    }

    // ── response parsing + refusal ─────────────────────────────────────────────────

    @Test
    fun parseResponse_extractsStructuredJson() {
        val body = JSONObject()
            .put("stop_reason", "end_turn")
            .put("content", JSONArray().put(JSONObject().put("type", "text").put("text", """{"reply":"Sure, sounds good."}""")))
            .toString()
        val r = AnthropicApi.parseResponse(200, body)
        assertTrue(r is AiResult.Ok)
        assertEquals("Sure, sounds good.", (r as AiResult.Ok).value.getString("reply"))
        println("PROOF[parse] structured JSON extracted from the text content block")
    }

    @Test
    fun parseResponse_handlesRefusal_andHttpErrors() {
        val refusal = JSONObject().put("stop_reason", "refusal").put("content", JSONArray()).toString()
        assertTrue(AnthropicApi.parseResponse(200, refusal) is AiResult.Err)
        assertTrue((AnthropicApi.parseResponse(401, "{}") as AiResult.Err).message.contains("key"))
        assertTrue((AnthropicApi.parseResponse(429, "{}") as AiResult.Err).message.contains("rate limit", ignoreCase = true))
        println("PROOF[parse] stop_reason=refusal and HTTP 401/429 map to user-facing errors")
    }

    // ── incremental sweep (the zero-token property) ────────────────────────────────

    @Test
    fun sweep_reSweepUnchangedInbox_spendsNoTokens() {
        var apiCalls = 0
        val service = AiService { _, _, _, _ -> apiCalls++; AiResult.Err("should not be called") }
        // Both messages already have a cache → nothing to send.
        val messages = listOf(
            msg("m1", cache = """[{"task":"Pay invoice","priority":"high"}]"""),
            msg("m2", cache = """[]""") // analyzed, produced no tasks
        )
        val outcome = (service.sweep(messages, emptyList(), SweepScope.UNREAD, now) as AiResult.Ok).value
        assertEquals(0, apiCalls, "no API call when everything is cached")
        assertEquals(0, outcome.result.freshCount)
        assertEquals(1, outcome.result.tasks.size)
        assertEquals("Pay invoice", outcome.result.tasks[0].task)
        println("PROOF[sweep] re-sweep of a fully-cached inbox makes 0 API calls, freshCount=0")
    }

    @Test
    fun sweep_sendsOnlyUncached_cachesResults_dropsCompleted() {
        var sentPrompt = ""
        val service = AiService { _, content, _, _ ->
            sentPrompt = content.getJSONObject(0).getString("text")
            AiResult.Ok(
                JSONObject().put(
                    "tasks",
                    JSONArray()
                        .put(JSONObject().put("task", "Review PR").put("priority", "urgent").put("sourceMessageId", "m2"))
                        .put(JSONObject().put("task", "Already done").put("priority", "low").put("sourceMessageId", "m2"))
                )
            )
        }
        val messages = listOf(
            msg("m1", subject = "cached", cache = """[{"task":"Pay invoice","priority":"high"}]"""),
            msg("m2", subject = "fresh") // no cache → the only one sent
        )
        val completed = listOf(CompletedTask(SweepTask(SweepPlanner.dedupeKey("m2", "Already done"), "Already done", AiPriority.LOW, "m2", "fresh", "boss@x"), 1))

        val outcome = (service.sweep(messages, completed, SweepScope.ALL, now) as AiResult.Ok).value
        assertTrue(sentPrompt.contains("[id: m2]") && !sentPrompt.contains("[id: m1]"), "only the uncached message m2 is sent")
        assertEquals(1, outcome.result.freshCount)
        // cache written for the sent message (even the completed task is cached on the row)
        assertTrue(outcome.cacheUpdates.containsKey("m2"))
        assertTrue(outcome.cacheUpdates["m2"]!!.contains("Review PR"))
        // final open list: cached "Pay invoice" + fresh "Review PR"; "Already done" dropped as completed
        val tasks = outcome.result.tasks.map { it.task }.toSet()
        assertEquals(setOf("Pay invoice", "Review PR"), tasks)
        println("PROOF[sweep] only uncached sent; results cached; completed task filtered out")
    }

    @Test
    fun dedupeKey_normalizesWhitespaceAndCase() {
        assertEquals(SweepPlanner.dedupeKey("m1", "Pay  the INVOICE"), SweepPlanner.dedupeKey("m1", "pay the invoice"))
        println("PROOF[dedupe] key normalizes whitespace + case")
    }
}
