package orbit.ai

/**
 * Prompt construction for the three AI features — ported from `ai-service.ts`
 * (audit §7). Pure string logic (truncation, sender-direction, thread labeling),
 * unit-tested so the model gets exactly the context the desktop sent.
 */
object Prompts {
    const val MAX_BODY_CHARS = 8000
    const val DRAFT_BODY_CHARS = 4000
    const val SWEEP_BODY_CHARS = 1500
    const val MAX_THREAD_MESSAGES = 12
    const val SWEEP_MAX_MESSAGES = 40
    const val COMPLETED_CONTEXT_LIMIT = 25

    fun stripHtml(html: String): String =
        html.replace(Regex("(?is)<(script|style)[^>]*>.*?</\\1>"), " ")
            .replace(Regex("(?s)<[^>]+>"), " ")
            .replace(Regex("&nbsp;"), " ")
            .replace(Regex("\\s+"), " ")
            .trim()

    private fun body(msg: AiMessage, cap: Int): String {
        val text = msg.bodyText?.takeIf { it.isNotBlank() } ?: msg.bodyHtml?.let { stripHtml(it) } ?: ""
        return if (text.length > cap) text.substring(0, cap) else text
    }

    private fun addressedToUser(msg: AiMessage, selfEmails: Set<String>): Boolean {
        val from = msg.from.lowercase()
        return selfEmails.none { from.contains(it.lowercase()) }
    }

    // ── analyze ────────────────────────────────────────────────────────────────

    val ANALYZE_SYSTEM = """
        You analyze a single email for the user. Distinguish direction: things the
        user must do (the message is addressed TO them) are action items; things the
        user already asked of others (the message is FROM them) are not the user's
        action items. Be concise and specific.
    """.trimIndent()

    fun analyzeUser(msg: AiMessage, selfEmails: Set<String>): String {
        val direction = if (addressedToUser(msg, selfEmails)) "This message was sent TO you." else "This message was sent BY you."
        return buildString {
            appendLine(direction)
            appendLine("From: ${msg.from}")
            appendLine("To: ${msg.to}")
            appendLine("Subject: ${msg.subject}")
            appendLine()
            append(body(msg, MAX_BODY_CHARS))
        }
    }

    // ── draft reply ──────────────────────────────────────────────────────────────

    private val TONE_GUIDANCE = mapOf(
        DraftTone.BRIEF to "Keep it short — a few sentences at most.",
        DraftTone.NEUTRAL to "A normal, balanced reply.",
        DraftTone.DETAILED to "Thorough; address each point raised."
    )

    fun draftSystem(userName: String, tone: DraftTone): String = """
        You are drafting an email reply on behalf of $userName. Write only the reply
        body (no subject, no signature). ${TONE_GUIDANCE[tone]}
    """.trimIndent()

    /** Grounds the draft in the whole thread (up to [MAX_THREAD_MESSAGES]). */
    fun draftUser(thread: List<AiMessage>, selfEmails: Set<String>): String = buildString {
        appendLine("Conversation (oldest first):")
        for (m in thread.takeLast(MAX_THREAD_MESSAGES)) {
            val who = if (addressedToUser(m, selfEmails)) "FROM ${m.from}" else "FROM YOU"
            appendLine("--- $who ---")
            appendLine(body(m, DRAFT_BODY_CHARS))
        }
        appendLine()
        append("Write the reply to the most recent message.")
    }

    // ── tasks sweep ──────────────────────────────────────────────────────────────

    fun sweepSystem(completed: List<CompletedTask>): String = buildString {
        appendLine("Extract concrete, actionable tasks the user must do from the emails below.")
        appendLine("For each task give a priority (urgent/high/medium/low) and the source message id.")
        val recent = completed.takeLast(COMPLETED_CONTEXT_LIMIT)
        if (recent.isNotEmpty()) {
            appendLine()
            appendLine("Already completed — do NOT list these again:")
            recent.forEach { appendLine("- ${it.task.task}") }
        }
    }

    /** Only [messages] whose cache is null should be passed here (incremental sweep). */
    fun sweepUser(messages: List<AiMessage>, selfEmails: Set<String>): String = buildString {
        for (m in messages.take(SWEEP_MAX_MESSAGES)) {
            val dir = if (addressedToUser(m, selfEmails)) "TO YOU" else "FROM YOU"
            appendLine("[id: ${m.id}] ($dir) Subject: ${m.subject}")
            appendLine(body(m, SWEEP_BODY_CHARS))
            appendLine()
        }
    }
}
