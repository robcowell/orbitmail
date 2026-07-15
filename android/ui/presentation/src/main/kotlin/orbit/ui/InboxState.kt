package orbit.ui

/**
 * Inbox list UI state + a pure reducer. The desktop applied optimistic
 * read/star/flag/move/delete with rollback (`patchMessageInList` in
 * mailStore.ts, audit §Performance). Here that logic is pure and unit-tested;
 * the Android ViewModel just holds this in a StateFlow and restores the prior
 * value if the backing repository call fails (rollback).
 */
data class InboxUiState(
    val rows: List<MessageRow> = emptyList(),
    val selectedId: String? = null,
    val threadedView: Boolean = true,
    val unreadOnly: Boolean = false,
    val loading: Boolean = false
) {
    /** Rows actually shown, after the per-folder unread filter. */
    val visibleRows: List<MessageRow>
        get() = if (unreadOnly) rows.filter { !it.isRead } else rows
}

object InboxReducer {

    private inline fun InboxUiState.patch(id: String, transform: (MessageRow) -> MessageRow): InboxUiState =
        copy(rows = rows.map { if (it.id == id) transform(it) else it })

    fun markRead(state: InboxUiState, id: String, isRead: Boolean): InboxUiState =
        state.patch(id) { it.copy(isRead = isRead) }

    fun toggleStar(state: InboxUiState, id: String, isStarred: Boolean): InboxUiState =
        state.patch(id) { it.copy(isStarred = isStarred) }

    fun setFlag(state: InboxUiState, id: String, flag: FlagColor?): InboxUiState =
        state.patch(id) { it.copy(flagColor = flag) }

    fun select(state: InboxUiState, id: String?): InboxUiState = state.copy(selectedId = id)

    fun setThreadedView(state: InboxUiState, threaded: Boolean): InboxUiState = state.copy(threadedView = threaded)

    fun setUnreadOnly(state: InboxUiState, unreadOnly: Boolean): InboxUiState = state.copy(unreadOnly = unreadOnly)

    /**
     * Remove rows (optimistic delete / move). If the selection was removed, it
     * advances to the next row (or the previous one if it was last), so the
     * reader doesn't blank out — the same UX the desktop had.
     */
    fun remove(state: InboxUiState, ids: Set<String>): InboxUiState {
        if (ids.isEmpty()) return state
        val newRows = state.rows.filterNot { it.id in ids }
        val newSelected = when {
            state.selectedId == null || state.selectedId !in ids -> state.selectedId
            else -> {
                val idx = state.rows.indexOfFirst { it.id == state.selectedId }
                val after = state.rows.drop(idx + 1).firstOrNull { it.id !in ids }
                val before = state.rows.take(idx).lastOrNull { it.id !in ids }
                (after ?: before)?.id
            }
        }
        return state.copy(rows = newRows, selectedId = newSelected)
    }

    /**
     * Background-refresh merge: adopt the server's rows as truth, but keep the
     * current selection if that message still exists. (Compose keys rows by id
     * for stable recomposition — the "reference-preserving refresh" of audit
     * §Performance is handled by keys, not object identity.)
     */
    fun mergeRefresh(state: InboxUiState, incoming: List<MessageRow>): InboxUiState {
        val stillPresent = state.selectedId != null && incoming.any { it.id == state.selectedId }
        return state.copy(rows = incoming, selectedId = if (stillPresent) state.selectedId else null, loading = false)
    }
}
