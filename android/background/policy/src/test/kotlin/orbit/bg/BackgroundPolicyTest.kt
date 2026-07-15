package orbit.bg

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BackgroundPolicyTest {

    private val idle = AccountSyncPref("idle", SyncMode.Idle)
    private val poll15 = AccountSyncPref("p15", SyncMode.Poll(15))
    private val poll60 = AccountSyncPref("p60", SyncMode.Poll(60))
    private val idleUnsupported = AccountSyncPref("noidle", SyncMode.Idle, serverSupportsIdle = false)

    @Test
    fun effectiveMode_fallsBackToPoll_whenServerLacksIdle() {
        assertEquals(SyncMode.Idle, SyncSchedulePolicy.effectiveMode(idle))
        assertEquals(SyncMode.Poll(SyncSchedulePolicy.IDLE_SAFETY_POLL_MINUTES), SyncSchedulePolicy.effectiveMode(idleUnsupported))
        println("PROOF[mode] IDLE requested but unsupported → safety-interval polling")
    }

    @Test
    fun foregroundService_runsWhenAppOpen_orAnyIdleAccount() {
        assertTrue(SyncSchedulePolicy.needsForegroundService(listOf(poll60), appInForeground = true), "app open → FGS")
        assertTrue(SyncSchedulePolicy.needsForegroundService(listOf(idle), appInForeground = false), "IDLE account → FGS")
        assertFalse(SyncSchedulePolicy.needsForegroundService(listOf(poll60), appInForeground = false), "poll-only, backgrounded → no FGS")
        assertFalse(SyncSchedulePolicy.needsForegroundService(listOf(idleUnsupported), appInForeground = false), "IDLE-unsupported degrades to poll → no FGS")
        println("PROOF[fgs] foreground service iff app open or an IDLE account is live")
    }

    @Test
    fun idleAccounts_excludeUnsupported() {
        assertEquals(listOf("idle"), SyncSchedulePolicy.idleAccounts(listOf(idle, poll60, idleUnsupported)))
    }

    @Test
    fun workerInterval_isTightestCadence_clampedTo15() {
        // idle→30 safety, poll60→60 → tightest 30, ≥15 floor.
        assertEquals(30, SyncSchedulePolicy.workerIntervalMinutes(listOf(idle, poll60)))
        // poll15→15 already at the floor.
        assertEquals(15, SyncSchedulePolicy.workerIntervalMinutes(listOf(poll15, poll60)))
        // a sub-floor request is clamped up.
        assertEquals(15, SyncSchedulePolicy.workerIntervalMinutes(listOf(AccountSyncPref("x", SyncMode.Poll(5)))))
        assertEquals(15, SyncSchedulePolicy.workerIntervalMinutes(emptyList()))
        println("PROOF[worker] periodic interval = tightest cadence, clamped to the 15-min floor")
    }

    @Test
    fun accountsDue_respectPerAccountIntervalWithinOneWorker() {
        val now = 1_000_000_000_000L
        val prefs = listOf(poll15, poll60)
        // p15 last synced 20 min ago (due); p60 last synced 20 min ago (not due).
        val last = mapOf("p15" to now - 20 * 60_000L, "p60" to now - 20 * 60_000L)
        assertEquals(listOf("p15"), SyncSchedulePolicy.accountsDue(prefs, last, now))
        // After 65 min both are due.
        val last2 = mapOf("p15" to now - 65 * 60_000L, "p60" to now - 65 * 60_000L)
        assertEquals(listOf("p15", "p60"), SyncSchedulePolicy.accountsDue(prefs, last2, now))
        println("PROOF[due] one 15-min worker still honours 60-min per-account cadence")
    }

    @Test
    fun pollSchedule_anchoredNextRun() {
        val anchor = 1_000_000_000_000L
        val now = anchor + 7 * 60_000L // 7 min past the anchor
        // 15-min anchored → next fire at anchor + 15 min.
        assertEquals(anchor + 15 * 60_000L, PollSchedule.nextRunMs(anchor, 15, now))
        // Exactly on a boundary advances to the next period.
        assertEquals(anchor + 30 * 60_000L, PollSchedule.nextRunMs(anchor, 15, anchor + 15 * 60_000L))
        // Before the anchor → fire at the anchor.
        assertEquals(anchor, PollSchedule.nextRunMs(anchor, 15, anchor - 5_000L))
        println("PROOF[poll] anchored next-run stays on a stable cadence")
    }

    @Test
    fun backoff_isExponential_andClamped() {
        assertEquals(30, PollSchedule.backoffSeconds(1))
        assertEquals(60, PollSchedule.backoffSeconds(2))
        assertEquals(120, PollSchedule.backoffSeconds(3))
        assertEquals(3600, PollSchedule.backoffSeconds(20), "clamped to the 1-hour max")
        println("PROOF[backoff] 30→60→120…, clamped to 3600s")
    }

    @Test
    fun notification_truncatesAndPluralizes() {
        val one = NewMailNotification.build("rob@rob-cowell.com", "Jane Doe <jane@x>", "Lunch?", 1)
        assertEquals("rob@rob-cowell.com", one.title)
        assertEquals("Jane Doe\nLunch?", one.body)

        val many = NewMailNotification.build("Work", "boss@x", "Q3 numbers", 3)
        assertEquals("boss@x\nQ3 numbers\n+2 more messages", many.body)

        val singleMore = NewMailNotification.build("Work", "a@x", "hi", 2)
        assertTrue(singleMore.body.endsWith("+1 more message"), "singular 'message' for +1")

        val longSubject = NewMailNotification.build("A", "x@y", "s".repeat(200), 1)
        assertTrue(longSubject.body.split("\n")[1].endsWith("…"))
        assertTrue(longSubject.body.split("\n")[1].length <= 80)
        println("PROOF[notif] account title, sender+subject body, +N more, truncation")
    }
}
