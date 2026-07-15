package orbit.bg

/**
 * Builds the new-mail notification text — a port of the desktop
 * `showNewMailNotification` (audit §IPC notifications). Pure string logic:
 * account on the title, sender + subject in the body, each truncated, with a
 * "+N more" tail. Local-only; no FCM (out of scope v1, plan §7).
 */
object NewMailNotification {

    data class Content(val title: String, val body: String)

    fun build(accountLabel: String, fromHeader: String?, subject: String?, newCount: Int): Content {
        if (newCount <= 0) return Content("Orbit Mail", "")
        val title = truncate(accountLabel.ifBlank { "Orbit Mail" }, 64)
        val sender = truncate(senderName(fromHeader).ifBlank { "Unknown sender" }, 40)
        val subj = truncate(subject?.ifBlank { null } ?: "(no subject)", 80)
        val body = buildString {
            append(sender).append('\n').append(subj)
            if (newCount > 1) {
                val more = newCount - 1
                append("\n+").append(more).append(" more message").append(if (more == 1) "" else "s")
            }
        }
        return Content(title, body)
    }

    /** "Jane Doe" from `Jane Doe <jane@x>`, else the bare address. */
    private fun senderName(from: String?): String {
        if (from.isNullOrBlank()) return ""
        val m = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<[^>]+>\\s*$").find(from)
        val name = m?.groupValues?.get(1)?.trim()
        if (!name.isNullOrEmpty()) return name
        return from.replace(Regex("[<>]"), "").trim()
    }

    private fun truncate(value: String, max: Int): String {
        val trimmed = value.trim()
        return if (trimmed.length > max) trimmed.substring(0, max - 1).trimEnd() + "…" else trimmed
    }
}
