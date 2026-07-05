import { useEffect, useRef } from 'react'
import {
  useMailStore,
  moveMessageToTrash,
  archiveMessage,
  markMessageUnread,
  toggleMessageStar,
  runSearch,
  clearSearch,
  openTasksDialog
} from '../../stores/mailStore'
import { useThemeStore } from '../../stores/themeStore'
import { AppBrand } from '../brand/AppBrand'
import { resolveSearchAccountId, searchAccountLabel } from '../../utils/search'
import {
  iconProps,
  PencilLine,
  ArrowBendUpLeft,
  ArrowBendUpRight,
  Trash,
  Archive,
  ArrowsClockwise,
  MagnifyingGlass,
  Star,
  Envelope,
  Sparkle,
  ListChecks
} from '../icons'

function ThemeToggle() {
  const darkMode = useThemeStore((s) => s.darkMode)
  const setDarkMode = useThemeStore((s) => s.setDarkMode)

  return (
    <div className="theme-toggle">
      <span className="theme-toggle-label">Dark</span>
      <button
        type="button"
        className="theme-switch"
        role="switch"
        aria-checked={darkMode}
        aria-label="Toggle dark mode"
        title="Toggle dark mode"
        onClick={() => setDarkMode(!darkMode)}
      />
    </div>
  )
}

export function Toolbar() {
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const accounts = useMailStore((s) => s.accounts)
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const searchQuery = useMailStore((s) => s.searchQuery)
  const setToast = useMailStore((s) => s.setToast)
  const syncStatus = useMailStore((s) => s.syncStatus)
  const isOnline = useMailStore((s) => s.isOnline)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const searchAccountId = resolveSearchAccountId(selectedFolderId, folders)
  const searchScopeLabel = searchAccountLabel(searchAccountId, accounts)
  const searchEnabled = searchAccountId != null

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  const handleCompose = () => {
    const accountId = accounts[0]?.id
    if (!accountId) {
      useMailStore.getState().setShowAddAccount(true)
      return
    }
    window.orbitMail.compose.open({ accountId })
  }

  const handleReply = () => {
    if (!selectedMessage) return
    window.orbitMail.compose.open({
      accountId: selectedMessage.accountId,
      mode: 'reply',
      originalMessageId: selectedMessage.id
    })
  }

  const handleForward = () => {
    if (!selectedMessage) return
    window.orbitMail.compose.open({
      accountId: selectedMessage.accountId,
      mode: 'forward',
      originalMessageId: selectedMessage.id
    })
  }

  const handleDelete = async () => {
    if (!selectedMessageId) return
    try {
      await moveMessageToTrash(selectedMessageId)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const handleArchive = async () => {
    if (!selectedMessageId) return
    try {
      await archiveMessage(selectedMessageId)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Archive failed')
    }
  }

  const handleMarkUnread = async () => {
    if (!selectedMessageId) return
    try {
      await markMessageUnread(selectedMessageId)
      setToast('Marked as unread')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Update failed')
    }
  }

  const handleToggleStar = async () => {
    if (!selectedMessageId || !selectedMessage) return
    try {
      await toggleMessageStar(selectedMessageId, !selectedMessage.isStarred)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Update failed')
    }
  }

  const handleRefresh = async () => {
    if (!isOnline) {
      setToast('You are offline — showing cached mail')
      return
    }
    try {
      await window.orbitMail.sync.refresh()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Sync failed')
    }
  }

  const handleSearch = (value: string) => {
    if (!searchAccountId) {
      if (value.trim()) clearSearch()
      return
    }

    useMailStore.getState().setSearchQuery(value)
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)

    if (!value.trim()) {
      clearSearch()
      return
    }

    searchTimerRef.current = setTimeout(() => {
      void runSearch(value, searchAccountId).catch((err) => {
        setToast(err instanceof Error ? err.message : 'Search failed')
      })
    }, 200)
  }

  const searchPlaceholder = searchEnabled
    ? searchScopeLabel
      ? `Search ${searchScopeLabel}…`
      : 'Search this account…'
    : 'Select a folder to search'

  return (
    <div className="toolbar">
      <AppBrand compact />

      <div className="toolbar-divider" />

      <button className="toolbar-btn-compose" title="Compose (C)" onClick={handleCompose}>
        <PencilLine {...iconProps} weight="bold" />
        Compose
      </button>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          title="Reply (R)"
          onClick={handleReply}
          disabled={!selectedMessage}
        >
          <ArrowBendUpLeft {...iconProps} />
        </button>
        <button
          className="toolbar-btn"
          title="Forward"
          onClick={handleForward}
          disabled={!selectedMessage}
        >
          <ArrowBendUpRight {...iconProps} />
        </button>
        <button
          className="toolbar-btn"
          title="Delete"
          onClick={handleDelete}
          disabled={!selectedMessageId}
        >
          <Trash {...iconProps} />
        </button>
        <button
          className="toolbar-btn"
          title="Archive"
          onClick={handleArchive}
          disabled={!selectedMessageId}
        >
          <Archive {...iconProps} />
        </button>
        <button
          className={`toolbar-btn${selectedMessage?.isStarred ? ' active' : ''}`}
          title="Star"
          onClick={handleToggleStar}
          disabled={!selectedMessageId}
        >
          <Star {...iconProps} weight={selectedMessage?.isStarred ? 'fill' : 'duotone'} />
        </button>
        <button
          className="toolbar-btn"
          title="Mark unread"
          onClick={handleMarkUnread}
          disabled={!selectedMessageId || !selectedMessage?.isRead}
        >
          <Envelope {...iconProps} />
        </button>
        <button
          className="toolbar-btn"
          title="Refresh"
          onClick={handleRefresh}
          disabled={syncStatus.syncing}
        >
          <ArrowsClockwise
            {...iconProps}
            className={syncStatus.syncing ? 'spin' : undefined}
          />
        </button>
      </div>

      <div className="toolbar-spacer" />

      <button
        className="toolbar-btn"
        title="Tasks from your mail"
        onClick={() => void openTasksDialog()}
      >
        <ListChecks {...iconProps} />
      </button>

      <button
        className="toolbar-btn"
        title="AI settings"
        onClick={() => useMailStore.getState().setShowAiSettings(true)}
      >
        <Sparkle {...iconProps} />
      </button>

      <ThemeToggle />

      <div className={`search-wrap${searchEnabled ? '' : ' search-wrap-disabled'}`}>
        <MagnifyingGlass {...iconProps} size={16} className="search-icon" />
        <input
          className="search-input"
          placeholder={searchPlaceholder}
          value={searchQuery}
          disabled={!searchEnabled}
          aria-disabled={!searchEnabled}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>
    </div>
  )
}
