import { useEffect, useRef, useState } from 'react'
import type { SearchField } from '../../../shared/types'
import {
  useMailStore,
  deleteSelectedMessages,
  deleteSelectedThreads,
  archiveSelectedMessages,
  archiveSelectedThreads,
  markMessageUnread,
  toggleMessageStar,
  runSearch,
  clearSearch,
  openSettings,
  composeAccountId
} from '../../stores/mailStore'
import { useThemeStore } from '../../stores/themeStore'
import { AppBrand } from '../brand/AppBrand'
import { resolveSearchScope, searchPlaceholder as buildSearchPlaceholder } from '../../utils/search'
import {
  iconProps,
  SidebarSimple,
  PencilLine,
  Trash,
  Archive,
  ArrowsClockwise,
  MagnifyingGlass,
  Star,
  GearSix,
  Envelope,
  XCircle,
  CaretRight
} from '../icons'
import { ipcErrorMessage } from '../../utils/ipcError'

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

const SEARCH_FIELDS: { value: SearchField; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'from', label: 'From' },
  { value: 'to', label: 'To' },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Body' }
]

// Dropdown that picks which field the search matches against (All/From/To/…).
function SearchScopeMenu({
  value,
  disabled,
  onChange
}: {
  value: SearchField
  disabled: boolean
  onChange: (field: SearchField) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const current = SEARCH_FIELDS.find((f) => f.value === value) ?? SEARCH_FIELDS[0]

  return (
    <div className="search-scope" ref={ref}>
      <button
        type="button"
        className="search-scope-btn"
        disabled={disabled}
        title="Choose which fields to search"
        onClick={() => setOpen((o) => !o)}
      >
        {current.label}
        <CaretRight size={11} weight="bold" style={{ transform: 'rotate(90deg)', opacity: 0.7 }} />
      </button>
      {open && (
        <div className="search-scope-menu" role="menu">
          {SEARCH_FIELDS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="menuitem"
              className={`search-scope-option${f.value === value ? ' active' : ''}`}
              onClick={() => {
                setOpen(false)
                onChange(f.value)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Toolbar() {
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectedThreadId = useMailStore((s) => s.selectedThreadId)
  const selectedThreadKeys = useMailStore((s) => s.selectedThreadKeys)
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const accounts = useMailStore((s) => s.accounts)
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const searchQuery = useMailStore((s) => s.searchQuery)
  const searchField = useMailStore((s) => s.searchField)
  const setToast = useMailStore((s) => s.setToast)
  const syncStatus = useMailStore((s) => s.syncStatus)
  const isOnline = useMailStore((s) => s.isOnline)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // `accountId: null` here means "every account", not "no scope" — the unified
  // inbox is searchable, which is the whole point of this scope object.
  const sidebarVisible = useMailStore((s) => s.sidebarVisible)
  const toggleSidebar = useMailStore((s) => s.toggleSidebar)
  // What the button reflects is what is on screen, which below the breakpoint
  // is "hidden" even though the user has expressed no preference.
  const sidebarShown =
    sidebarVisible ?? (typeof window !== 'undefined' && window.innerWidth >= 900)

  const searchScope = resolveSearchScope(selectedFolderId, folders, accounts)
  const searchAccountId = searchScope.accountId
  const searchEnabled = searchScope.enabled

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [])

  const handleCompose = () => {
    // The account whose folder is open, not simply the first one.
    const accountId = composeAccountId()
    if (!accountId) {
      useMailStore.getState().setShowAddAccount(true)
      return
    }
    window.orbitMail.compose.open({ accountId })
  }

  // Reply / Reply All / Forward used to live here too. They act on one message,
  // so they belong on the message — the reader header carries all three, as do
  // the Message menu and right-click. Here they were also dead half the time:
  // opening a conversation nulls `selectedMessage`, which left them greyed out
  // with a conversation open in front of you. The toolbar is for what acts on
  // the list or the app.

  // Conversation view keeps selectedMessageId null, so both of these took the
  // thread branch or did nothing at all before.
  const threadSelection = selectedThreadKeys.length > 0 || !!selectedThreadId
  const hasSelection = threadSelection || !!selectedMessageId

  const handleDelete = async () => {
    if (!hasSelection) return
    try {
      if (threadSelection) await deleteSelectedThreads()
      else await deleteSelectedMessages()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Delete failed'))
    }
  }

  const handleArchive = async () => {
    if (!hasSelection) return
    try {
      if (threadSelection) await archiveSelectedThreads()
      else await archiveSelectedMessages()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Archive failed'))
    }
  }

  const handleMarkUnread = async () => {
    if (!selectedMessageId) return
    try {
      await markMessageUnread(selectedMessageId)
      setToast('Marked as unread')
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Update failed'))
    }
  }

  const handleToggleStar = async () => {
    if (!selectedMessageId || !selectedMessage) return
    try {
      await toggleMessageStar(selectedMessageId, !selectedMessage.isStarred)
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Update failed'))
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
      setToast(ipcErrorMessage(err, 'Sync failed'))
    }
  }

  const handleSearch = (value: string) => {
    if (!searchEnabled) {
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
      void runSearch(value, searchAccountId, searchField).catch((err) => {
        setToast(ipcErrorMessage(err, 'Search failed'))
      })
    }, 200)
  }

  const handleClearSearch = () => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    clearSearch()
    searchInputRef.current?.focus()
  }

  // Changing scope re-runs the current query immediately against the new field.
  const handleScopeChange = (field: SearchField) => {
    useMailStore.getState().setSearchField(field)
    if (searchEnabled && searchQuery.trim()) {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
      void runSearch(searchQuery, searchAccountId, field).catch((err) => {
        setToast(ipcErrorMessage(err, 'Search failed'))
      })
    }
  }

  const searchPlaceholder = buildSearchPlaceholder(searchScope)

  return (
    <div className="toolbar">
      <AppBrand compact />

      {/* The sidebar collapses on its own below ~900px, so there has to be a way
          back — and a way to reclaim its width deliberately at any size. */}
      <button
        className="toolbar-btn"
        title={sidebarShown ? 'Hide folders' : 'Show folders'}
        aria-pressed={sidebarShown}
        onClick={toggleSidebar}
      >
        <SidebarSimple {...iconProps} weight={sidebarShown ? 'fill' : 'duotone'} />
      </button>

      <div className="toolbar-divider" />

      <button className="toolbar-btn-compose" title="Compose (C)" onClick={handleCompose}>
        <PencilLine {...iconProps} weight="bold" />
        Compose
      </button>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          title="Delete"
          onClick={handleDelete}
          disabled={!hasSelection}
        >
          <Trash {...iconProps} />
        </button>
        <button
          className="toolbar-btn"
          title="Archive"
          onClick={handleArchive}
          disabled={!hasSelection}
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
        title="Settings (Ctrl+,)"
        onClick={() => openSettings()}
      >
        <GearSix {...iconProps} />
      </button>

      <ThemeToggle />

      <div className="search-area">
        <SearchScopeMenu
          value={searchField}
          disabled={!searchEnabled}
          onChange={handleScopeChange}
        />
        <div className={`search-wrap${searchEnabled ? '' : ' search-wrap-disabled'}`}>
          <MagnifyingGlass {...iconProps} size={16} className="search-icon" />
        <input
          ref={searchInputRef}
          className="search-input"
          placeholder={searchPlaceholder}
          value={searchQuery}
          disabled={!searchEnabled}
          aria-disabled={!searchEnabled}
          onChange={(e) => handleSearch(e.target.value)}
        />
        {searchQuery.length > 0 && (
          <button
            type="button"
            className="search-clear"
            title="Clear search"
            aria-label="Clear search"
            onClick={handleClearSearch}
          >
            <XCircle size={16} weight="fill" />
          </button>
        )}
        </div>
      </div>
    </div>
  )
}
