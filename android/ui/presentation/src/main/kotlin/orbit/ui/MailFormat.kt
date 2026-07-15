package orbit.ui

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Display formatting for the list/reader. Pure (now/zone/locale injected). */
object MailFormat {

    /** "Jane Doe" from `Jane Doe <jane@x>`; the bare address otherwise. */
    fun senderDisplayName(from: String): String {
        val m = Regex("^\\s*\"?([^\"<]*?)\"?\\s*<([^>]+)>\\s*$").find(from)
        val name = m?.groupValues?.get(1)?.trim()
        if (!name.isNullOrEmpty()) return name
        return from.replace(Regex("[<>]"), "").trim()
    }

    /** Compact list date: time today, weekday within a week, else date. */
    fun listDate(thenMs: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.US): String {
        val then = Instant.ofEpochMilli(thenMs).atZone(zone)
        val now = Instant.ofEpochMilli(nowMs).atZone(zone)
        val fmt = when {
            then.toLocalDate() == now.toLocalDate() -> DateTimeFormatter.ofPattern("HH:mm", locale)
            then.toLocalDate().isAfter(now.toLocalDate().minusDays(7)) -> DateTimeFormatter.ofPattern("EEE", locale)
            then.year == now.year -> DateTimeFormatter.ofPattern("d MMM", locale)
            else -> DateTimeFormatter.ofPattern("d MMM yyyy", locale)
        }
        return then.format(fmt)
    }

    /** Human byte size (1024-based, one decimal). */
    fun byteSize(bytes: Long, locale: Locale = Locale.US): String {
        if (bytes < 1024) return "$bytes B"
        val units = listOf("KB", "MB", "GB", "TB")
        var value = bytes.toDouble() / 1024
        var i = 0
        while (value >= 1024 && i < units.size - 1) { value /= 1024; i++ }
        return String.format(locale, "%.1f %s", value, units[i])
    }
}
