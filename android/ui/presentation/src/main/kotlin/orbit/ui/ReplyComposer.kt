package orbit.ui

/**
 * Builds reply / reply-all / forward drafts from a source message — a port of
 * the desktop `buildReplyPayload` / `buildReplyAllCc` (audit §5 SMTP notes).
 * Pure and unit-tested: recipient de-duplication, self-exclusion, subject
 * prefixing, and the RFC References chain are exactly where reply bugs hide.
 */
object ReplyComposer {

    private data class Addr(val display: String, val email: String)

    /** Split an address-list header into typed addresses. */
    private fun parse(header: String?): List<Addr> {
        if (header.isNullOrBlank()) return emptyList()
        return header.split(",").mapNotNull { raw ->
            val part = raw.trim().ifEmpty { return@mapNotNull null }
            val m = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<([^>]+)>\\s*$").find(part)
            if (m != null) Addr(m.groupValues[1].trim(), m.groupValues[2].trim().lowercase())
            else Addr("", part.trim().lowercase())
        }
    }

    private fun emailOf(header: String?): String? = parse(header).firstOrNull()?.email

    private fun join(addrs: List<Addr>): String =
        addrs.joinToString(", ") { if (it.display.isNotEmpty()) "${it.display} <${it.email}>" else it.email }

    private fun replySubject(subject: String): String =
        if (Regex("^\\s*re:\\s", RegexOption.IGNORE_CASE).containsMatchIn(subject)) subject.trim() else "Re: ${subject.trim()}"

    private fun forwardSubject(subject: String): String =
        if (Regex("^\\s*(fwd?|fw):\\s", RegexOption.IGNORE_CASE).containsMatchIn(subject)) subject.trim() else "Fwd: ${subject.trim()}"

    /** References chain: prior References + the parent's Message-ID (RFC 5322). */
    private fun buildReferences(source: MessageContent): String? {
        val parts = buildList {
            source.references?.split(Regex("\\s+"))?.filter { it.isNotBlank() }?.let { addAll(it) }
            source.messageId?.let { add(it) }
        }
        return parts.joinToString(" ").ifBlank { null }
    }

    private fun attribution(source: MessageContent): String {
        val who = parse(source.from).firstOrNull()?.let { if (it.display.isNotEmpty()) it.display else it.email } ?: "someone"
        return "On a previous date, $who wrote:"
    }

    private fun quoteText(source: MessageContent): String {
        val body = source.bodyText ?: ""
        return attribution(source) + "\n" + body.lines().joinToString("\n") { "> $it" }
    }

    private fun quoteHtml(source: MessageContent): String {
        val body = source.bodyHtml ?: source.bodyText?.let { "<p>${it.replace("\n", "<br>")}</p>" } ?: ""
        return "<p>${attribution(source)}</p><blockquote>$body</blockquote>"
    }

    fun reply(source: MessageContent): ComposeDraft = ComposeDraft(
        to = source.from,
        subject = replySubject(source.subject),
        inReplyTo = source.messageId,
        references = buildReferences(source),
        quotedText = quoteText(source),
        quotedHtml = quoteHtml(source),
        mode = ComposeMode.REPLY,
        originalMessageId = source.id
    )

    /**
     * Reply-all: To = original sender; Cc = (original To + Cc) minus the user's
     * own addresses and minus the sender, de-duplicated by lowercased email,
     * order preserved.
     */
    fun replyAll(source: MessageContent, selfAddresses: Set<String>): ComposeDraft {
        val self = selfAddresses.map { it.lowercase() }.toSet()
        val fromEmail = emailOf(source.from)
        val seen = HashSet<String>()
        val cc = (parse(source.to) + parse(source.cc))
            .filter { it.email.isNotBlank() && it.email !in self && it.email != fromEmail && seen.add(it.email) }
        return reply(source).copy(cc = join(cc), mode = ComposeMode.REPLY_ALL)
    }

    fun forward(source: MessageContent): ComposeDraft = ComposeDraft(
        subject = forwardSubject(source.subject),
        quotedText = quoteText(source),
        quotedHtml = quoteHtml(source),
        mode = ComposeMode.FORWARD,
        originalMessageId = source.id
    )
}
