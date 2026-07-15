package orbit.ui.compose

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import orbit.ui.FlagColor
import orbit.ui.InboxReducer
import orbit.ui.InboxUiState

/**
 * Holds the inbox list state in a StateFlow and drives it through the verified
 * [InboxReducer]. Optimistic mutations patch the state immediately and roll back
 * to the captured prior value if the repository call fails — the exact pattern
 * covered by PresentationTest.optimisticStar_thenRollback.
 */
class InboxViewModel(private val repo: MailUiRepository) : ViewModel() {

    private val _state = MutableStateFlow(InboxUiState(loading = true))
    val state: StateFlow<InboxUiState> = _state.asStateFlow()

    /** Observe the folder's flat rows; Room emits on every DB change (audit §4). */
    fun observe(folderId: String) {
        viewModelScope.launch {
            repo.observeMessageRows(folderId, _state.value.unreadOnly).collect { rows ->
                _state.value = InboxReducer.mergeRefresh(_state.value, rows)
            }
        }
    }

    fun select(id: String) {
        _state.value = InboxReducer.select(_state.value, id)
        // Opening a message marks it read (optimistic).
        markRead(id, true)
    }

    fun markRead(id: String, isRead: Boolean) =
        optimistic({ InboxReducer.markRead(it, id, isRead) }) { repo.setRead(id, isRead) }

    fun toggleStar(id: String, isStarred: Boolean) =
        optimistic({ InboxReducer.toggleStar(it, id, isStarred) }) { repo.setStarred(id, isStarred) }

    fun setFlag(id: String, flag: FlagColor?) =
        optimistic({ InboxReducer.setFlag(it, id, flag) }) { repo.setFlag(id, flag) }

    fun delete(id: String) =
        optimistic({ InboxReducer.remove(it, setOf(id)) }) { repo.delete(id) }

    fun move(id: String, targetFolderId: String) =
        optimistic({ InboxReducer.remove(it, setOf(id)) }) { repo.move(id, targetFolderId) }

    fun setUnreadOnly(unreadOnly: Boolean) { _state.value = InboxReducer.setUnreadOnly(_state.value, unreadOnly) }
    fun setThreadedView(threaded: Boolean) { _state.value = InboxReducer.setThreadedView(_state.value, threaded) }

    /** Apply a reducer patch instantly, then run the backing action; roll back on failure. */
    private fun optimistic(patch: (InboxUiState) -> InboxUiState, action: suspend () -> Unit) {
        val prior = _state.value
        _state.value = patch(prior)
        viewModelScope.launch {
            runCatching { action() }.onFailure { _state.value = prior }
        }
    }
}
