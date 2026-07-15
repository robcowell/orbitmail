package orbit.ai

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON Schemas for structured outputs (audit §7). Sent as
 * `output_config.format = { type: "json_schema", schema }` on /v1/messages, which
 * constrains the model's response to valid, parseable JSON. Every object sets
 * `additionalProperties: false` + `required` per the structured-outputs contract.
 */
object Schemas {

    private fun stringArray() = JSONObject().put("type", "array").put("items", JSONObject().put("type", "string"))

    private fun obj(properties: JSONObject, required: List<String>) = JSONObject()
        .put("type", "object")
        .put("additionalProperties", false)
        .put("properties", properties)
        .put("required", JSONArray(required))

    val ANALYZE: JSONObject = obj(
        JSONObject()
            .put("summary", JSONObject().put("type", "string"))
            .put("actionItems", stringArray())
            .put("questions", stringArray())
            .put("keyContext", stringArray()),
        listOf("summary", "actionItems", "questions", "keyContext")
    )

    val DRAFT: JSONObject = obj(
        JSONObject().put("reply", JSONObject().put("type", "string")),
        listOf("reply")
    )

    val SWEEP: JSONObject = run {
        val task = obj(
            JSONObject()
                .put("task", JSONObject().put("type", "string"))
                .put("priority", JSONObject().put("type", "string").put("enum", JSONArray(listOf("urgent", "high", "medium", "low"))))
                .put("sourceMessageId", JSONObject().put("type", "string")),
            listOf("task", "priority", "sourceMessageId")
        )
        obj(
            JSONObject().put("tasks", JSONObject().put("type", "array").put("items", task)),
            listOf("tasks")
        )
    }
}
