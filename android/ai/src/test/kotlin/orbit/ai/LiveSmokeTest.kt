package orbit.ai

import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable

/**
 * Layer 3 handoff: a real Anthropic call, gated on ANTHROPIC_API_KEY (skipped
 * here — no key in the sandbox). Confirms end-to-end that the request shape,
 * structured-output parsing, and model id actually work against the live API.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... gradle test --tests '*LiveSmokeTest*'
 */
class LiveSmokeTest {

    @Test
    @EnabledIfEnvironmentVariable(named = "ANTHROPIC_API_KEY", matches = ".+")
    fun analyze_realCall() {
        val key = System.getenv("ANTHROPIC_API_KEY")
        val service = AiService { system, content, schema, maxTokens ->
            AnthropicClient().call(key, system, content, schema, maxTokens)
        }
        val msg = AiMessage(
            id = "m1", from = "boss@example.com", to = "me@example.com",
            subject = "Q3 report due Friday",
            date = 0, bodyText = "Please send me the Q3 numbers by Friday and confirm the board meeting time.", bodyHtml = null
        )
        val result = service.analyze(msg, setOf("me@example.com"), 1_700_000_000_000L)
        assertTrue(result is AiResult.Ok, "live analyze failed: $result")
        val analysis = (result as AiResult.Ok).value
        assertTrue(analysis.actionItems.isNotEmpty(), "expected at least one action item")
        println("PROOF[live] analyze returned ${analysis.actionItems.size} action items")
    }
}
