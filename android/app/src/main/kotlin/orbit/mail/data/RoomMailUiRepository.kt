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
 * Propagates a local mutation to the server (audit §4 write-path). Implemented in
 * the app (AppGraph) over `:sync:engine` ImapMutations. Best-effort: a failure
 * leaves the optimistic local state to self-heal on the next sync (flag reconcile
 * pulls the true server flags; a failed delete/move re-imports on re-sync).
 */
interface ServerMutations {
    suspend fun setSeen(accountId: String, folderId: String, uid: Long, isRead: Boolean)
    suspend fun setFlagged(accountId: String, folderId: String, uid: Long, isFlagged: Boolean)
    suspend fun delete(accountId: String, folderId: String, uid: Long)
    suspend fun move(accountId: String, folderId: String, uid: Long, targetFolderId: String)
}

/**
 * Implements the Step 5 UI port [MailUiRepository] over the Step 2 Room DAOs
 * (reactive Flow reads + mutations), plus injected hooks for the pieces that
 * live in other layers: [refresh] runs the Step 4 sync engine, [sendMail] does
 * SMTP, [server] propagates read/flag/move/delete to IMAP. Maps the DAO
 * projections to the UI models.
 */
class RoomMailUiRepository(
    private val messageDao: MessageDao,
    private val refresh: suspend (accountId: String?) -> Unit,
    private val sendMail: suspend (draft: ComposeDraft, accountId: String) -> Unit,
    private val server: ServerMutations,
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

    // Local write is immediate (drives the Room Flow → UI); [server] then mirrors
    // it to IMAP. For delete/move the local row is removed, so the message's
    // (accountId, folderId, uid) is captured first. server ops are best-effort
    // (AppGraph swallows + logs) so a transient IMAP failure never breaks the UI.
    override suspend fun setRead(id: String, isRead: Boolean) {
        val m = messageDao.getById(id) ?: return
        messageDao.setRead(id, isRead)
        server.setSeen(m.accountId, m.folderId, m.uid, isRead)
    }

    override suspend fun setStarred(id: String, isStarred: Boolean) {
        val m = messageDao.getById(id) ?: return
        messageDao.setStarred(id, isStarred)
        server.setFlagged(m.accountId, m.folderId, m.uid, isStarred)
    }

    override suspend fun setFlag(id: String, flag: UiFlagColor?) {
        // Flag colour is local-only (IMAP has no colour, only a boolean \Flagged
        // owned by the star). Mirrors the desktop, which never sends colour.
        messageDao.setFlag(id, flag?.let { DataFlagColor.valueOf(it.name) })
    }

    override suspend fun delete(id: String) {
        val m = messageDao.getById(id) ?: return
        messageDao.deleteById(id)
        server.delete(m.accountId, m.folderId, m.uid)
    }

    override suspend fun move(id: String, targetFolderId: String) {
        val m = messageDao.getById(id) ?: return
        messageDao.deleteById(id)
        // Server MOVE; the message re-imports into the target on the next sync.
        server.move(m.accountId, m.folderId, m.uid, targetFolderId)
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
