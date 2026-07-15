package orbit.ui.compose

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import orbit.ui.ComposeDraft
import orbit.ui.MessageContent
import orbit.ui.ReplyComposer

/** Loads a whole conversation (cross-folder) and produces reply/forward drafts. */
class ReaderViewModel(private val repo: MailUiRepository) : ViewModel() {

    data class ReaderState(val messages: List<MessageContent> = emptyList(), val loading: Boolean = true)

    private val _state = MutableStateFlow(ReaderState())
    val state: StateFlow<ReaderState> = _state

    fun openThread(accountId: String, threadId: String) {
        viewModelScope.launch {
            _state.value = ReaderState(loading = true)
            _state.value = ReaderState(messages = repo.getThread(accountId, threadId), loading = false)
        }
    }

    private fun latest(): MessageContent? = _state.value.messages.lastOrNull()

    fun reply(): ComposeDraft? = latest()?.let { ReplyComposer.reply(it) }
    fun replyAll(selfAddresses: Set<String>): ComposeDraft? = latest()?.let { ReplyComposer.replyAll(it, selfAddresses) }
    fun forward(): ComposeDraft? = latest()?.let { ReplyComposer.forward(it) }
}
