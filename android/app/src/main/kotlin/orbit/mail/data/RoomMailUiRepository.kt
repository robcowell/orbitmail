package orbit.mail.data

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map
import orbit.data.dao.MessageDao
import orbit.data.entity.MessageEntity
import orbit.ui.ComposeDraft
import orbit.ui.MessageContent
import orbit.ui.MessageRow
import orbit.ui.SearchState
import orbit.ui.ThreadRow
import orbit.ui.compose.MailUiRepository
import orbit.data.FlagColor as DataFlagColor
import orbit.data.MessageSummary as DataMessageSummary
import orbit.data.ThreadSummaryRow as DataThreadRow
import orbit.ui.FlagColor as UiFlagColor
import orbit.ui.SearchField as UiSearchField

private const val PAGE = 500

/**
 * Implements the Step 5 UI port [MailUiRepository] over the Step 2 Room DAOs
 * (reactive Flow reads + mutations), plus injected hooks for the pieces that
 * live in other layers: [refresh] runs the Step 4 sync engine, [sendMail] does
 * SMTP. Maps the DAO projections to the UI models.
 */
class RoomMailUiRepository(
    private val messageDao: MessageDao,
    private val refresh: suspend (accountId: String?) -> Unit,
    private val sendMail: suspend (draft: ComposeDraft, accountId: String) -> Unit,
) : MailUiRepository {

    override fun observeThreadRows(folderId: String, unreadOnly: Boolean): Flow<List<ThreadRow>> {
        val flow = if (folderId == "unified") messageDao.listThreadsUnified(unreadOnly, PAGE, 0)
        else messageDao.listThreads(folderId, unreadOnly, PAGE, 0)
        return flow.map { rows -> rows.map { it.toUi() } }
    }

    override fun observeMessageRows(folderId: String, unreadOnly: Boolean): Flow<List<MessageRow>> {
        val flow = if (folderId == "unified") messageDao.listUnified(unreadOnly, PAGE, 0)
        else messageDao.listByFolder(folderId, unreadOnly, PAGE, 0)
        return flow.map { rows -> rows.map { it.toUi() } }
    }

    override suspend fun getThread(accountId: String, threadId: String): List<MessageContent> =
        messageDao.getThread(accountId, threadId).map { it.toContent() }

    override suspend fun getMessage(id: String): MessageContent? = messageDao.getById(id)?.toContent()

    // Local write is immediate (drives the Room Flow → UI). Server propagation
    // (mark \Seen/\Flagged, MOVE, DELETE via ImapConnection) is a follow-on:
    // the desktop's markMessageReadOnServer/moveMessageOnServer belong on the
    // Step 4 engine, wired through here.
    override suspend fun setRead(id: String, isRead: Boolean) {
        messageDao.setRead(id, isRead) /* TODO: propagate \Seen to server */
    }

    override suspend fun setStarred(id: String, isStarred: Boolean) {
        messageDao.setStarred(id, isStarred) /* TODO: propagate \Flagged to server */
    }

    override suspend fun setFlag(id: String, flag: UiFlagColor?) {
        messageDao.setFlag(id, flag?.let { DataFlagColor.valueOf(it.name) }) /* TODO: server \Flagged */
    }

    override suspend fun delete(id: String) {
        messageDao.deleteById(id) /* TODO: server DELETE/MOVE-to-trash */
    }

    override suspend fun move(id: String, targetFolderId: String) {
        messageDao.deleteById(id) /* TODO: server MOVE, then let sync re-import into target */
    }

    override suspend fun send(draft: ComposeDraft, accountId: String) = sendMail(draft, accountId)

    override suspend fun search(text: String, accountId: String, field: UiSearchField): List<MessageRow> {
        val like = SearchState.buildLikePattern(text)
        val rows = when (field) {
            UiSearchField.FROM -> messageDao.searchFrom(accountId, like, 50)
            UiSearchField.TO -> messageDao.searchTo(accountId, like, 50)
            UiSearchField.SUBJECT -> messageDao.searchSubject(accountId, like, 50)
            UiSearchField.BODY -> messageDao.searchBody(accountId, like, 50)
            UiSearchField.ALL -> messageDao.searchAll(accountId, like, 50)
        }
        return rows.map { it.toUi() }
    }

    override suspend fun refresh(accountId: String?) = refresh.invoke(accountId)

    // ── mapping ──────────────────────────────────────────────────────────────

    private fun DataFlagColor?.toUi(): UiFlagColor? = this?.let { UiFlagColor.valueOf(it.name) }

    private fun DataMessageSummary.toUi() = MessageRow(
        id = id, threadId = threadId, from = from, subject = subject, snippet = snippet,
        date = date, isRead = isRead, isStarred = isStarred, flagColor = flagColor.toUi(), hasAttachments = hasAttachments
    )

    private fun DataThreadRow.toUi() = ThreadRow(
        threadId = threadId, latestMessageId = latestMessageId,
        // TODO: participants aggregation (distinct sender names, oldest first) —
        // Step 2 deferred it; the latest sender is a placeholder for now.
        participants = listOf(from),
        subject = subject, snippet = snippet, date = date, messageCount = messageCount,
        hasUnread = hasUnread, isStarred = isStarred, flagColor = flagColor.toUi(), hasAttachments = hasAttachments
    )

    private fun MessageEntity.toContent() = MessageContent(
        id = id, messageId = messageId, references = references, from = from, to = to, cc = cc,
        subject = subject, date = date, bodyText = bodyText, bodyHtml = bodyHtml
    )
}
