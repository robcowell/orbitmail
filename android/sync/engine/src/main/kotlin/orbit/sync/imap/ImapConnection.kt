package orbit.sync.imap

import com.sun.mail.imap.IMAPFolder
import orbit.sync.ParsedMessage
import orbit.sync.RemoteFolder
import java.io.Closeable
import java.util.Date
import javax.mail.FetchProfile
import javax.mail.Flags
import javax.mail.Folder
import javax.mail.Message
import javax.mail.UIDFolder
import javax.mail.internet.MimeMessage
import javax.mail.search.ComparisonTerm
import javax.mail.search.ReceivedDateTerm

/**
 * Thin wrapper over a connected Jakarta Mail [com.sun.mail.imap.IMAPStore],
 * exposing the exact IMAP operations the sync engine needs. Uses the same
 * `com.sun.mail.imap.*` API proven Android-compatible by the spike.
 */
class ImapConnection(private val store: com.sun.mail.imap.IMAPStore) : Closeable {

    /** LIST all mailboxes. `selectable` = HOLDS_MESSAGES (i.e. not \Noselect). */
    fun listFolders(): List<RemoteFolder> =
        store.defaultFolder.list("*").map { f ->
            RemoteFolder(
                path = f.fullName,
                name = f.name,
                selectable = (f.type and Folder.HOLDS_MESSAGES) != 0
            )
        }

    fun <T> withFolder(path: String, write: Boolean, block: (OpenFolder) -> T): T {
        val folder = store.getFolder(path) as IMAPFolder
        folder.open(if (write) Folder.READ_WRITE else Folder.READ_ONLY)
        try {
            return block(OpenFolder(folder))
        } finally {
            if (folder.isOpen) folder.close(false)
        }
    }

    override fun close() {
        if (store.isConnected) store.close()
    }

    /** Operations against one open IMAP folder. */
    class OpenFolder(private val folder: IMAPFolder) {
        val uidValidity: Long get() = folder.uidValidity
        val uidNext: Long get() = folder.uidNext
        val messageCount: Int get() = folder.messageCount

        /** Most-recent [limit] UIDs, restricted to messages on/after [sinceMs]. */
        fun recentUids(limit: Int, sinceMs: Long?): List<Long> {
            val candidates: Array<Message> =
                if (sinceMs != null) {
                    // SINCE narrows the initial batch; fall back to ALL if the
                    // server rejects the date search (mirrors the desktop fallback).
                    try {
                        folder.search(ReceivedDateTerm(ComparisonTerm.GE, Date(sinceMs)))
                    } catch (_: Exception) {
                        folder.messages
                    }
                } else folder.messages
            if (candidates.isEmpty()) return emptyList()
            prefetch(candidates, envelope = true)
            return candidates
                .map { it as MimeMessage }
                .sortedByDescending { (it.sentDate ?: it.receivedDate)?.time ?: 0L }
                .take(limit)
                .map { folder.getUID(it) }
        }

        /** UIDs strictly greater than [afterUid] (the incremental delta). */
        fun uidsAfter(afterUid: Long): List<Long> {
            val msgs = folder.getMessagesByUID(afterUid + 1, UIDFolder.LASTUID) ?: return emptyList()
            if (msgs.isEmpty()) return emptyList()
            prefetch(msgs, envelope = false)
            return msgs.filterNotNull().map { folder.getUID(it) }.filter { it > afterUid }.sorted()
        }

        fun fetchByUids(uids: List<Long>, folderId: String, accountId: String, nowMs: Long): List<ParsedMessage> {
            if (uids.isEmpty()) return emptyList()
            val msgs = folder.getMessagesByUID(uids.toLongArray()).filterNotNull().toTypedArray()
            prefetch(msgs, envelope = true)
            return msgs.map { MimeParsing.parse(folder, it as MimeMessage, folderId, accountId, nowMs) }
        }

        /** (uid, seen, flagged) for every message — the full-scan flag reconcile. */
        fun allFlags(): List<Triple<Long, Boolean, Boolean>> {
            val msgs = folder.messages
            if (msgs.isEmpty()) return emptyList()
            val fp = FetchProfile().apply { add(UIDFolder.FetchProfileItem.UID); add(FetchProfile.Item.FLAGS) }
            folder.fetch(msgs, fp)
            return msgs.map {
                Triple(folder.getUID(it), it.flags.contains(Flags.Flag.SEEN), it.flags.contains(Flags.Flag.FLAGGED))
            }
        }

        /** UIDs still present on the server (for expunge detection). */
        fun survivorUids(): Set<Long> {
            val msgs = folder.getMessagesByUID(1L, UIDFolder.LASTUID) ?: return emptySet()
            if (msgs.isEmpty()) return emptySet()
            prefetch(msgs, envelope = false)
            return msgs.filterNotNull().map { folder.getUID(it) }.toSet()
        }

        fun setSeen(uid: Long, value: Boolean) = setFlag(uid, Flags.Flag.SEEN, value)
        fun setFlagged(uid: Long, value: Boolean) = setFlag(uid, Flags.Flag.FLAGGED, value)

        private fun setFlag(uid: Long, flag: Flags.Flag, value: Boolean) {
            val msg = folder.getMessageByUID(uid) ?: return
            folder.setFlags(arrayOf(msg), Flags(flag), value)
        }

        private fun prefetch(msgs: Array<Message>, envelope: Boolean) {
            val fp = FetchProfile().apply {
                add(UIDFolder.FetchProfileItem.UID)
                add(FetchProfile.Item.FLAGS)
                if (envelope) {
                    add(FetchProfile.Item.ENVELOPE)
                    add("References")
                    add("In-Reply-To")
                }
            }
            folder.fetch(msgs, fp)
        }
    }
}
