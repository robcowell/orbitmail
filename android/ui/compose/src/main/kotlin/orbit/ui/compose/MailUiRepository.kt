package orbit.ui.compose

import kotlinx.coroutines.flow.Flow
import orbit.ui.ComposeDraft
import orbit.ui.FlagColor
import orbit.ui.MessageContent
import orbit.ui.MessageRow
import orbit.ui.SearchField
import orbit.ui.ThreadRow

/**
 * The port the UI ViewModels depend on. Implemented in the app by an adapter over
 * the Step 2 Room DAOs (reactive Flow reads, mutations), the Step 4 sync engine
 * (refresh), and SMTP send. Kept as an interface so ViewModel logic stays
 * testable and this module doesn't hard-depend on Room here.
 */
interface MailUiRepository {
    fun observeThreadRows(folderId: String, unreadOnly: Boolean): Flow<List<ThreadRow>>
    fun observeMessageRows(folderId: String, unreadOnly: Boolean): Flow<List<MessageRow>>

    suspend fun getThread(accountId: String, threadId: String): List<MessageContent>
    suspend fun getMessage(id: String): MessageContent?

    suspend fun setRead(id: String, isRead: Boolean)
    suspend fun setStarred(id: String, isStarred: Boolean)
    suspend fun setFlag(id: String, flag: FlagColor?)
    suspend fun delete(id: String)
    suspend fun move(id: String, targetFolderId: String)

    suspend fun send(draft: ComposeDraft, accountId: String)
    suspend fun search(text: String, accountId: String, field: SearchField): List<MessageRow>
    suspend fun refresh(accountId: String?)
}
