import { useMailStore, refreshMessages } from '../../stores/mailStore'
import { useThemeStore } from '../../stores/themeStore'
import { AppBrand } from '../brand/AppBrand'
import {
  iconProps,
  PencilLine,
  ArrowBendUpLeft,
  ArrowBendUpRight,
  Trash,
  Archive,
  ArrowsClockwise,
  MagnifyingGlass
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
  const searchQuery = useMailStore((s) => s.searchQuery)
  const setSearchQuery = useMailStore((s) => s.setSearchQuery)
  const setToast = useMailStore((s) => s.setToast)
  const syncStatus = useMailStore((s) => s.syncStatus)

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
      to: selectedMessage.from,
      subject: selectedMessage.subject.startsWith('Re:')
        ? selectedMessage.subject
        : `Re: ${selectedMessage.subject}`,
      bodyText: `\n\n${selectedMessage.bodyText ?? ''}`,
      bodyHtml: `<br><br><blockquote>${selectedMessage.bodyHtml ?? selectedMessage.bodyText ?? ''}</blockquote>`,
      mode: 'reply',
      originalMessageId: selectedMessage.id
    })
  }

  const handleForward = () => {
    if (!selectedMessage) return
    window.orbitMail.compose.open({
      accountId: selectedMessage.accountId,
      subject: selectedMessage.subject.startsWith('Fwd:')
        ? selectedMessage.subject
        : `Fwd: ${selectedMessage.subject}`,
      bodyText: `\n\n---------- Forwarded message ----------\n${selectedMessage.bodyText ?? ''}`,
      bodyHtml: `<br><br>---------- Forwarded message ----------<br>${selectedMessage.bodyHtml ?? selectedMessage.bodyText ?? ''}`,
      mode: 'forward',
      originalMessageId: selectedMessage.id
    })
  }

  const handleDelete = async () => {
    if (!selectedMessageId) return
    try {
      await window.orbitMail.messages.delete(selectedMessageId)
      useMailStore.getState().setSelectedMessage(null)
      useMailStore.getState().setSelectedMessageId(null)
      await refreshMessages()
      setToast('Message deleted')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  const handleRefresh = async () => {
    try {
      await window.orbitMail.sync.refresh()
      await refreshMessages()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Sync failed')
    }
  }

  const handleSearch = async (value: string) => {
    setSearchQuery(value)
    if (!value.trim()) {
      useMailStore.getState().setSearchResults([])
      return
    }
    const results = await window.orbitMail.search.query(value)
    useMailStore.getState().setSearchResults(results)
  }

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
        <button className="toolbar-btn" title="Archive" disabled>
          <Archive {...iconProps} />
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

      <ThemeToggle />

      <div className="search-wrap">
        <MagnifyingGlass {...iconProps} size={16} className="search-icon" />
        <input
          className="search-input"
          placeholder="Search mail…"
          value={searchQuery}
          onChange={(e) => handleSearch(e.target.value)}
        />
      </div>
    </div>
  )
}
