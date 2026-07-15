package orbit.ui.compose

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import orbit.ui.ComposeDraft

/** Backs the composer screen: edits a [ComposeDraft] and sends it. */
class ComposeViewModel(private val repo: MailUiRepository) : ViewModel() {

    data class ComposeUiState(val draft: ComposeDraft = ComposeDraft(), val sending: Boolean = false, val sent: Boolean = false, val error: String? = null)

    private val _state = MutableStateFlow(ComposeUiState())
    val state: StateFlow<ComposeUiState> = _state

    /** Seed from a reply/forward draft (from ReaderViewModel) or start blank. */
    fun start(draft: ComposeDraft) { _state.value = ComposeUiState(draft = draft) }

    fun update(transform: (ComposeDraft) -> ComposeDraft) { _state.value = _state.value.copy(draft = transform(_state.value.draft)) }

    fun send(accountId: String) {
        val draft = _state.value.draft
        _state.value = _state.value.copy(sending = true, error = null)
        viewModelScope.launch {
            runCatching { repo.send(draft, accountId) }
                .onSuccess { _state.value = _state.value.copy(sending = false, sent = true) }
                .onFailure { _state.value = _state.value.copy(sending = false, error = it.message) }
        }
    }
}
