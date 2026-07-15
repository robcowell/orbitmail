package orbit.sync.imap

import com.sun.mail.imap.IMAPFolder
import orbit.sync.ParsedMessage
import orbit.sync.ThreadUtil
import javax.mail.Address
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.Part
import javax.mail.internet.InternetAddress
import javax.mail.internet.MimeMessage

/** Turns a fetched Jakarta Mail [MimeMessage] into a persistable [ParsedMessage]. */
internal object MimeParsing {

    fun parse(folder: IMAPFolder, msg: MimeMessage, folderId: String, accountId: String, nowMs: Long): ParsedMessage {
        val uid = folder.getUID(msg)
        val messageId = msg.messageID
        val inReplyTo = ThreadUtil.normalizeReferences(msg.getHeader("In-Reply-To")?.joinToString(" "))
        val references = ThreadUtil.normalizeReferences(msg.getHeader("References")?.joinToString(" "))
        val subject = msg.subject ?: "(No subject)"
        val from = formatAddresses(msg.from)
        val to = formatAddresses(msg.getRecipients(Message.RecipientType.TO))
        val cc = formatAddresses(msg.getRecipients(Message.RecipientType.CC)).ifEmpty { null }
        val date = (msg.sentDate ?: msg.receivedDate)?.time ?: nowMs
        val flags = msg.flags
        val extracted = extractBody(msg)

        return ParsedMessage(
            folderId = folderId,
            accountId = accountId,
            uid = uid,
            messageId = messageId,
            inReplyTo = inReplyTo,
            references = references,
            threadId = ThreadUtil.computeThreadId(messageId, inReplyTo, references, subject),
            from = from,
            to = to,
            cc = cc,
            subject = subject,
            snippet = snippet(extracted.text ?: subject),
            date = date,
            isRead = flags.contains(javax.mail.Flags.Flag.SEEN),
            isStarred = flags.contains(javax.mail.Flags.Flag.FLAGGED),
            hasAttachments = extracted.hasAttachments,
            bodyText = extracted.text,
            bodyHtml = extracted.html
        )
    }

    private data class Extracted(val text: String?, val html: String?, val hasAttachments: Boolean)

    private fun extractBody(part: Part): Extracted {
        try {
            when {
                part.isMimeType("text/plain") -> return Extracted(part.content as? String, null, false)
                part.isMimeType("text/html") -> return Extracted(null, part.content as? String, false)
                part.isMimeType("multipart/*") -> {
                    val mp = part.content as? Multipart ?: return Extracted(null, null, false)
                    var text: String? = null
                    var html: String? = null
                    var hasAtt = false
                    for (i in 0 until mp.count) {
                        val bp = mp.getBodyPart(i)
                        val disposition = bp.disposition
                        if (Part.ATTACHMENT.equals(disposition, ignoreCase = true) || !bp.fileName.isNullOrBlank()) {
                            hasAtt = true
                            continue
                        }
                        val child = extractBody(bp)
                        if (text == null) text = child.text
                        if (html == null) html = child.html
                        if (child.hasAttachments) hasAtt = true
                    }
                    return Extracted(text, html, hasAtt)
                }
            }
        } catch (_: Exception) {
            // Malformed part — treat as empty rather than failing the whole sync.
        }
        return Extracted(null, null, false)
    }

    private fun snippet(text: String, max: Int = 120): String {
        val clean = text.replace(Regex("\\s+"), " ").trim()
        return if (clean.length > max) clean.substring(0, max) + "…" else clean
    }

    private fun formatAddresses(addrs: Array<Address>?): String {
        if (addrs.isNullOrEmpty()) return ""
        return addrs.joinToString(", ") { a ->
            val ia = a as? InternetAddress
            val name = ia?.personal
            val email = ia?.address ?: a.toString()
            if (!name.isNullOrBlank()) "$name <$email>" else email
        }
    }
}
