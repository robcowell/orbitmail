package orbit.ai

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * Minimal Anthropic Messages API client over OkHttp (audit §7). Request building
 * and response parsing are separated from the network call so both are unit-tested
 * without a live request. Uses structured outputs (`output_config.format`),
 * model `claude-opus-4-8`, effort `low`, and handles `stop_reason: "refusal"`.
 */
object AnthropicApi {
    const val MODEL = "claude-opus-4-8"
    const val ENDPOINT = "https://api.anthropic.com/v1/messages"
    const val ANTHROPIC_VERSION = "2023-06-01"

    /** A single user text block; attachments (image/pdf/text) are appended by the caller. */
    fun textContent(text: String): JSONArray =
        JSONArray().put(JSONObject().put("type", "text").put("text", text))

    fun buildRequestBody(system: String, userContent: JSONArray, schema: JSONObject, maxTokens: Int): JSONObject =
        JSONObject()
            .put("model", MODEL)
            .put("max_tokens", maxTokens)
            .put("system", system)
            .put("messages", JSONArray().put(JSONObject().put("role", "user").put("content", userContent)))
            .put(
                "output_config",
                JSONObject()
                    .put("effort", "low")
                    .put("format", JSONObject().put("type", "json_schema").put("schema", schema))
            )

    /** Parse an HTTP response into the structured JSON object, or a user-facing error. */
    fun parseResponse(httpCode: Int, body: String): AiResult<JSONObject> {
        if (httpCode != 200) return AiResult.Err(mapHttpError(httpCode, body))
        val obj = runCatching { JSONObject(body) }.getOrNull()
            ?: return AiResult.Err("The AI service returned an unreadable response.")
        // Safety classifiers can decline with HTTP 200 + stop_reason "refusal".
        if (obj.optString("stop_reason") == "refusal") {
            return AiResult.Err("The model declined to respond to this content.")
        }
        val content = obj.optJSONArray("content") ?: return AiResult.Err("The AI response contained no content.")
        for (i in 0 until content.length()) {
            val block = content.optJSONObject(i) ?: continue
            if (block.optString("type") == "text") {
                val text = block.optString("text")
                val parsed = runCatching { JSONObject(text) }.getOrNull()
                    ?: return AiResult.Err("The AI response was not valid structured output.")
                return AiResult.Ok(parsed)
            }
        }
        return AiResult.Err("The AI response contained no structured output.")
    }

    private fun mapHttpError(code: Int, body: String): String {
        val apiMessage = runCatching { JSONObject(body).optJSONObject("error")?.optString("message") }.getOrNull()
        return when (code) {
            401 -> "Invalid Anthropic API key."
            403 -> "This API key doesn't have permission for that request."
            429 -> "Anthropic rate limit reached — try again shortly."
            in 500..599 -> "The AI service is temporarily unavailable."
            else -> apiMessage?.takeIf { it.isNotBlank() } ?: "AI request failed (HTTP $code)."
        }
    }
}

class AnthropicClient(private val http: OkHttpClient = OkHttpClient()) {

    /** Blocking call (run off the main thread). Network failures map to an error result. */
    fun call(apiKey: String, system: String, userContent: JSONArray, schema: JSONObject, maxTokens: Int): AiResult<JSONObject> {
        val request = Request.Builder()
            .url(AnthropicApi.ENDPOINT)
            .header("x-api-key", apiKey)
            .header("anthropic-version", AnthropicApi.ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .post(AnthropicApi.buildRequestBody(system, userContent, schema, maxTokens).toString().toRequestBody("application/json".toMediaType()))
            .build()
        return try {
            http.newCall(request).execute().use { resp ->
                AnthropicApi.parseResponse(resp.code, resp.body?.string() ?: "")
            }
        } catch (e: IOException) {
            AiResult.Err("Couldn't reach the AI service: ${e.message}")
        }
    }
}
