package orbit.sync

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Pure-logic ports (threading, sync window, folder typing). */
class UtilTest {

    @Test
    fun threadId_prefersReferencesRoot_thenParent_thenSelf_thenSubject() {
        // References[0] is the thread root across Inbox + Sent.
        assertEquals("<root@x>", ThreadUtil.computeThreadId("<msg3@x>", "<msg2@x>", "<root@x> <msg2@x>", "Re: Hi"))
        // Falls back to In-Reply-To, then own Message-ID, then subject key.
        assertEquals("<parent@x>", ThreadUtil.computeThreadId("<m@x>", "<parent@x>", null, "Re: Hi"))
        assertEquals("<self@x>", ThreadUtil.computeThreadId("<self@x>", null, null, "Hi"))
        assertEquals("subj:hi", ThreadUtil.computeThreadId(null, null, null, "Re: Re: Hi"))
        println("PROOF[thread] References root → parent → self → subject precedence")
    }

    @Test
    fun normalizeSubject_stripsReplyPrefixes() {
        assertEquals("quarterly report", ThreadUtil.normalizeSubject("Re: Fwd:  RE: Quarterly Report"))
    }

    @Test
    fun syncWindow_cutoffAndMembership() {
        val now = 1_000_000_000_000L
        assertTrue(SyncWindow.isWithinWindow(now, 90, now))
        assertFalse(SyncWindow.isWithinWindow(now - 91L * 86_400_000, 90, now))
        assertTrue(SyncWindow.isWithinWindow(now - 200L * 86_400_000, 0, now), "syncDays<=0 = no limit")
        println("PROOF[window] 90-day cutoff; 0 = unlimited")
    }

    @Test
    fun folderTyping_specialUseThenName() {
        assertEquals(FolderType.SENT, FolderTyping.detect("Whatever", listOf("\\Sent")))
        assertEquals(FolderType.INBOX, FolderTyping.detect("INBOX"))
        assertEquals(FolderType.JUNK, FolderTyping.detect("Spam"))
        assertEquals(FolderType.CUSTOM, FolderTyping.detect("Receipts"))
        assertTrue(FolderTyping.isVirtualView(Provider.GMAIL, "[Gmail]/All Mail"))
        assertFalse(FolderTyping.isVirtualView(Provider.IMAP, "[Gmail]/All Mail"))
        println("PROOF[typing] SPECIAL-USE > name map > custom; Gmail virtual views flagged")
    }
}
