package orbit.spike

import com.sun.mail.imap.IMAPBodyPart
import com.sun.mail.imap.IMAPFolder
import com.sun.mail.imap.IMAPMessage
import com.sun.mail.imap.IMAPStore
import com.sun.mail.imap.SortTerm
import javax.mail.FetchProfile
import javax.mail.Flags
import javax.mail.Message
import javax.mail.Multipart
import javax.mail.UIDFolder
import javax.mail.search.FlagTerm

/**
 * LAYER 1 — compile-time API-surface proof.
 *
 * Every method referenced here is exercised by the *type checker*: if the
 * chosen library did not expose it, this file would not compile. That turns
 * "does the library support X?" into a build gate. The Android artifact
 * `com.sun.mail:android-mail:1.6.7` ships the byte-identical
 * `com.sun.mail.imap.*` / `javax.mail.*` classes, so a green compile here is a
 * green compile on Android.
 *
 * Nothing here needs to *run*; the sync engine's real behaviour is proven
 * end-to-end in ImapSpikeTest (Layer 2) and against Gmail (Layer 3).
 *
 * NAMESPACE: the 1.6.x line's Java package is `javax.mail` (the artifact is
 * *named* jakarta.mail but the packages did not rename until the Angus 2.x
 * line). Android uses this same 1.6.x/`javax.mail` line via `android-mail`.
 */
@Suppress("UNUSED_PARAMETER", "unused")
object CapabilityReference {

    /** CAP 1 — XOAUTH2: config-driven, no manual SASL. See Xoauth2.kt. */
    fun xoauth2(store: IMAPStore, host: String, email: String, accessToken: String) {
        // Access token passed as the "password"; mechanism selected by the
        // session property mail.imaps.auth.mechanisms=XOAUTH2.
        store.connect(host, email, accessToken)
        val advertised: Boolean = store.hasCapability("AUTH=XOAUTH2")
    }

    /** CAP 2 — IMAP IDLE: real server push. Blocks until activity; run on its own thread. */
    fun idle(folder: IMAPFolder) {
        folder.idle()        // void idle()
        folder.idle(true)    // void idle(boolean once)
    }

    /** CAP 3 — CONDSTORE / CHANGEDSINCE: cheap flag reconciliation. */
    fun condstore(folder: IMAPFolder, msg: IMAPMessage) {
        // FETCH (CHANGEDSINCE <modseq>) — only messages whose flags changed.
        val changed: Array<Message> = folder.getMessagesByUIDChangedSince(1L, UIDFolder.LASTUID, 0L)
        val modseq: Long = msg.modSeq // per-message MODSEQ (getModSeq())
    }

    /** CAP 4 — SORT: server-side ordering (REVERSE DATE), with SEARCH fallback in the engine. */
    fun sort(folder: IMAPFolder) {
        val sorted: Array<Message> = folder.getSortedMessages(arrayOf(SortTerm.REVERSE, SortTerm.DATE))
    }

    /** CAP 5 — partial BODYSTRUCTURE fetch: download ONE MIME part, not the whole message. */
    fun partialPartFetch(folder: IMAPFolder, msg: IMAPMessage) {
        msg.setPeek(true) // don't set \Seen while inspecting structure
        val fp = FetchProfile().apply {
            add(FetchProfile.Item.ENVELOPE)
            add(FetchProfile.Item.FLAGS)
            add(UIDFolder.FetchProfileItem.UID)
            add(IMAPFolder.FetchProfileItem.SIZE) // provider-specific prefetch item
        }
        folder.fetch(arrayOf<Message>(msg), fp)
        // Reading one part's stream issues FETCH BODY[<n>] — a partial download.
        val part = (msg.content as Multipart).getBodyPart(0) as IMAPBodyPart
        val bytes = part.inputStream.readBytes()
    }

    /** UID-based incremental sync primitives (the engine's core delta strategy). */
    fun uidPrimitives(folder: IMAPFolder) {
        val validity: Long = folder.uidValidity
        val uidNext: Long = folder.uidNext
        val byUid: Message? = folder.getMessageByUID(1L)
        val range: Array<Message> = folder.getMessagesByUID(1L, UIDFolder.LASTUID)
        val uid: Long = folder.getUID(range.firstOrNull() ?: return)
    }

    /** Flag mutation + SEARCH (read/star/delete + server-side search fallback). */
    fun flagsAndSearch(folder: IMAPFolder, msgs: Array<Message>) {
        folder.setFlags(msgs, Flags(Flags.Flag.SEEN), true)
        val unread: Array<Message> = folder.search(FlagTerm(Flags(Flags.Flag.SEEN), false))
    }
}
