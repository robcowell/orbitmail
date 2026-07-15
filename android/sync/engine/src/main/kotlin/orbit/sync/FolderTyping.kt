package orbit.sync

/** Folder-type detection — port of desktop `detectFolderType` (audit §4.1). */
object FolderTyping {

    // RFC 6154 SPECIAL-USE attributes take precedence.
    private val SPECIAL_USE = mapOf(
        "\\Inbox" to FolderType.INBOX,
        "\\Sent" to FolderType.SENT,
        "\\Drafts" to FolderType.DRAFTS,
        "\\Trash" to FolderType.TRASH,
        "\\Junk" to FolderType.JUNK
    )

    private val NAME_MAP = mapOf(
        "INBOX" to FolderType.INBOX,
        "Sent Mail" to FolderType.SENT,
        "Sent Items" to FolderType.SENT,
        "Sent" to FolderType.SENT,
        "Drafts" to FolderType.DRAFTS,
        "Trash" to FolderType.TRASH,
        "Deleted" to FolderType.TRASH,
        "Deleted Items" to FolderType.TRASH,
        "Junk" to FolderType.JUNK,
        "Spam" to FolderType.JUNK
    )

    fun detect(name: String, attributes: List<String> = emptyList()): FolderType {
        for (attr in attributes) SPECIAL_USE[attr]?.let { return it }
        if (name.equals("INBOX", ignoreCase = true)) return FolderType.INBOX
        return NAME_MAP[name] ?: FolderType.CUSTOM
    }

    // Gmail virtual-view folders excluded from unread math / normal sync (audit §4.1).
    private val GMAIL_VIRTUAL = Regex("^\\[Gmail]/(All Mail|Important|Starred|Snoozed)$", RegexOption.IGNORE_CASE)

    fun isVirtualView(provider: Provider, imapPath: String): Boolean =
        provider == Provider.GMAIL && GMAIL_VIRTUAL.matches(imapPath)
}
