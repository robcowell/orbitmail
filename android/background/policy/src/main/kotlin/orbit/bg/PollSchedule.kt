package orbit.bg

/** Anchored polling + failure backoff (AquaMail-style anchored interval, plan §2). */
object PollSchedule {

    /**
     * Next fire time for an [intervalMinutes] poll anchored at [anchorMs] — the
     * next anchor + k·interval strictly after [nowMs]. Anchoring keeps fires on a
     * stable cadence instead of drifting with each reschedule.
     */
    fun nextRunMs(anchorMs: Long, intervalMinutes: Int, nowMs: Long): Long {
        val interval = intervalMinutes.toLong() * 60_000
        if (nowMs < anchorMs) return anchorMs
        val elapsed = nowMs - anchorMs
        val periods = elapsed / interval + 1
        return anchorMs + periods * interval
    }

    /** Exponential backoff for a failed sync attempt (1-based), clamped. */
    fun backoffSeconds(attempt: Int, baseSeconds: Long = 30, maxSeconds: Long = 3600): Long {
        if (attempt <= 1) return baseSeconds
        val shift = (attempt - 1).coerceAtMost(20)
        val delay = baseSeconds shl shift // base * 2^(attempt-1)
        return if (delay <= 0 || delay > maxSeconds) maxSeconds else delay
    }
}
