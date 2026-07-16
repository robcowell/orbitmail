package orbit.sync.imap

import orbit.sync.SyncAccount

/**
 * Server-side write path (audit §4) — the outbound counterpart to [orbit.sync.SyncEngine].
 * Ports the desktop `imap-sync` mutation ops (`markMessageReadOnServer`,
 * `toggleMessageStarredOnServer`, `deleteMessageOnServer`, `moveMessageOnServer`):
 * each opens a READ_WRITE connection to the message's folder and applies one
 * change by UID. Blocking Jakarta Mail — call on an IO dispatcher.
 */
class ImapMutations(
    private val connect: (SyncAccount) -> ImapConnection = ImapConnectionFactory::connect
) {
    fun setSeen(account: SyncAccount, folderPath: String, uid: Long, isRead: Boolean) =
        onFolder(account, folderPath) { it.setSeen(uid, isRead) }

    fun setFlagged(account: SyncAccount, folderPath: String, uid: Long, isFlagged: Boolean) =
        onFolder(account, folderPath) { it.setFlagged(uid, isFlagged) }

    fun delete(account: SyncAccount, folderPath: String, uid: Long) =
        onFolder(account, folderPath) { it.deleteByUid(uid) }

    fun move(account: SyncAccount, sourcePath: String, uid: Long, targetPath: String) =
        onFolder(account, sourcePath) { it.moveByUid(uid, targetPath) }

    private fun onFolder(
        account: SyncAccount,
        path: String,
        block: (ImapConnection.OpenFolder) -> Unit
    ) {
        connect(account).use { conn -> conn.withFolder(path, write = true) { block(it) } }
    }
}
