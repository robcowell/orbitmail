package orbit.sync

/**
 * Threading — a direct port of the desktop `thread-util.ts` (audit §4.7). Derives
 * a stable per-conversation key from RFC 5322 headers.
 */
object ThreadUtil {

    /** Strip repeated leading Re:/Fwd:/Fw:, collapse whitespace, lowercase. */
    fun normalizeSubject(subject: String?): String =
        (subject ?: "")
            .replace(Regex("^(\\s*(re|fwd|fw)\\s*:\\s*)+", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\s+"), " ")
            .trim()
            .lowercase()

    /** Collapse a raw References/In-Reply-To header into one space-separated string. */
    fun normalizeReferences(value: String?): String? {
        if (value.isNullOrBlank()) return null
        val trimmed = value.replace(Regex("\\s+"), " ").trim()
        return trimmed.ifEmpty { null }
    }

    private fun firstToken(value: String?): String? =
        value?.trim()?.split(Regex("\\s+"))?.firstOrNull()?.takeIf { it.isNotEmpty() }

    /**
     * References[0] is the RFC thread root (present in every reply's chain across
     * Inbox and Sent) → immediate parent → own Message-ID → normalized-subject key.
     */
    fun computeThreadId(messageId: String?, inReplyTo: String?, references: String?, subject: String?): String {
        val root = firstToken(references) ?: firstToken(inReplyTo) ?: messageId
        if (!root.isNullOrEmpty()) return root
        return "subj:${normalizeSubject(subject)}"
    }
}
