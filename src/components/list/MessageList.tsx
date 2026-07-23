import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VList, type VListHandle } from 'virtua'
import type {
  FlagColor,
  MessageSummary,
  MessageDetail,
  ThreadSummary
} from '../../../shared/types'
import { collectDisplayNames, extractName } from '../../../shared/addresses'
import {
  useMailStore,
  selectMessage,
  selectAdjacentMessage,
  extendSelectionToAdjacent,
  selectMessageRange,
  toggleMessageSelection,
  selectThread,
  selectThreadRange,
  toggleThreadSelection,
  selectAdjacentThread,
  toggleThreadExpanded,
  loadMoreMessages,
  searchWholeMailbox
} from '../../stores/mailStore'
import { resolveSearchAccountId, searchAccountLabel } from '../../utils/search'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import { ThreadContextMenu } from '../messages/ThreadContextMenu'
import { flagColorHex } from '../../constants/flags'
import { Tray, Flag, Paperclip, MagnifyingGlass, CaretRight } from '../icons'

function formatDate(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()

  if (isToday) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  const isThisYear = date.getFullYear() === now.getFullYear()
  return date.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: isThisYear ? undefined : 'numeric'
  })
}

// ---- Search-result row (flat, single message) ----------------------------

interface MessageRowProps {
  message: MessageSummary
  displayName: string
  formattedDate: string
  isRead: boolean
  isSelected: boolean
  isActive: boolean
  isStarred: boolean
  flagColor: FlagColor | null
  folderName: string | null
  nested?: boolean
  onSelect: (event: React.MouseEvent, id: string) => void
  onContextMenu: (event: React.MouseEvent, message: MessageSummary) => void
}

const MessageRow = memo(function MessageRow({
  message,
  displayName,
  formattedDate,
  isRead,
  isSelected,
  isActive,
  isStarred,
  flagColor,
  folderName,
  nested,
  onSelect,
  onContextMenu
}: MessageRowProps) {
  const className = [
    'message-row',
    nested ? 'message-row-nested' : '',
    !isRead ? 'unread' : '',
    isSelected ? 'selected' : '',
    isActive ? 'active' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => onSelect(event, message.id)}
      onContextMenu={(event) => onContextMenu(event, message)}
    >
      <div className={`unread-dot${isRead ? ' read' : ''}`} />
      <div className="message-content">
        <div className="message-top">
          <span className="message-sender">{displayName}</span>
          <span className="message-date">
            {message.hasAttachments && (
              <Paperclip size={12} weight="duotone" className="message-attach" />
            )}
            {(flagColor || isStarred) && (
              <Flag
                size={12}
                weight="fill"
                className="message-star"
                style={{ color: flagColorHex(flagColor) ?? '#f5a623' }}
              />
            )}
            {formattedDate}
          </span>
        </div>
        <div className="message-subject">{message.subject}</div>
        {folderName !== null && <div className="message-folder">{folderName}</div>}
        <div className="message-snippet">{message.snippet}</div>
      </div>
    </div>
  )
})

// ---- Thread row (collapsed conversation) ---------------------------------

interface ThreadRowProps {
  thread: ThreadSummary
  participantsLabel: string
  formattedDate: string
  isSelected: boolean
  // True when this row is part of a multi-row selection but is not the lead —
  // it is highlighted and included in bulk actions, but the reader shows the lead.
  isInSelection: boolean
  expandable: boolean
  isExpanded: boolean
  onSelect: (event: React.MouseEvent, accountId: string, threadId: string) => void
  onToggleExpand: (accountId: string, threadId: string) => void
  onContextMenu: (event: React.MouseEvent, thread: ThreadSummary) => void
}

const ThreadRow = memo(function ThreadRow({
  thread,
  participantsLabel,
  formattedDate,
  isSelected,
  isInSelection,
  expandable,
  isExpanded,
  onSelect,
  onToggleExpand,
  onContextMenu
}: ThreadRowProps) {
  const className = [
    'message-row',
    thread.hasUnread ? 'unread' : '',
    isSelected || isInSelection ? 'selected' : '',
    isSelected && isInSelection ? 'active' : '',
    isExpanded ? 'expanded' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={className}
      onMouseDown={(event) => {
        if (event.shiftKey) event.preventDefault()
      }}
      onClick={(event) => onSelect(event, thread.accountId, thread.threadId)}
      onContextMenu={(event) => onContextMenu(event, thread)}
    >
      {expandable ? (
        <button
          type="button"
          className="thread-disclosure"
          aria-label={isExpanded ? 'Collapse conversation' : 'Expand conversation'}
          aria-expanded={isExpanded}
          onClick={(event) => {
            event.stopPropagation()
            onToggleExpand(thread.accountId, thread.threadId)
          }}
        >
          <CaretRight
            size={12}
            weight="bold"
            style={{ transform: isExpanded ? 'rotate(90deg)' : undefined }}
          />
        </button>
      ) : (
        <span className="thread-disclosure-spacer" />
      )}
      <div className={`unread-dot${thread.hasUnread ? '' : ' read'}`} />
      <div className="message-content">
        <div className="message-top">
          <span className="message-sender">
            {participantsLabel}
            {thread.messageCount > 1 && (
              <span className="thread-count">{thread.messageCount}</span>
            )}
          </span>
          <span className="message-date">
            {thread.hasAttachments && (
              <Paperclip size={12} weight="duotone" className="message-attach" />
            )}
            {(thread.flagColor || thread.isStarred) && (
              <Flag
                size={12}
                weight="fill"
                className="message-star"
                style={{ color: flagColorHex(thread.flagColor) ?? '#f5a623' }}
              />
            )}
            {formattedDate}
          </span>
        </div>
        <div className="message-subject">{thread.subject}</div>
        <div className="message-snippet">{thread.snippet}</div>
      </div>
    </div>
  )
})

function participantsLabel(names: string[]): string {
  if (names.length === 0) return '(unknown)'
  if (names.length <= 3) return names.join(', ')
  return `${names[0]}, ${names[1]}, +${names.length - 2}`
}

// ---- List ----------------------------------------------------------------

export function MessageList() {
  const threadedView = useMailStore((s) => s.threadedView)
  const threads = useMailStore((s) => s.threads)
  const threadTotal = useMailStore((s) => s.threadTotal)
  const expandedThreadKeys = useMailStore((s) => s.expandedThreadKeys)
  const expandedThreadMessages = useMailStore((s) => s.expandedThreadMessages)
  const messages = useMailStore((s) => s.messages)
  const messageTotal = useMailStore((s) => s.messageTotal)
  const selectedThreadId = useMailStore((s) => s.selectedThreadId)
  const selectedThreadKeys = useMailStore((s) => s.selectedThreadKeys)
  const searchQuery = useMailStore((s) => s.searchQuery)
  const searchResults = useMailStore((s) => s.searchResults)
  const searchLoading = useMailStore((s) => s.searchLoading)
  const serverSearched = useMailStore((s) => s.serverSearched)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectedMessageIds = useMailStore((s) => s.selectedMessageIds)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const folders = useMailStore((s) => s.folders)
  const accounts = useMailStore((s) => s.accounts)
  const loading = useMailStore((s) => s.loading)
  const listLoading = useMailStore((s) => s.listLoading)
  const setToast = useMailStore((s) => s.setToast)
  const [loadingMore, setLoadingMore] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    message: MessageSummary
    x: number
    y: number
  } | null>(null)
  const [threadMenu, setThreadMenu] = useState<{
    thread: ThreadSummary
    x: number
    y: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<VListHandle>(null)

  const isSearching = searchQuery.trim().length > 0
  const searchAccountId = resolveSearchAccountId(selectedFolderId, folders)
  const searchScopeLabel = searchAccountLabel(searchAccountId, accounts)

  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders]
  )
  const folderTypeById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.type])),
    [folders]
  )

  // A row in a Sent folder names who the mail went to — the sender is us, and
  // saying so in every row tells the reader nothing. Keyed off the message's own
  // folder, so a mixed list (search, unified) labels each row correctly.
  const rowDisplayName = useCallback(
    (message: MessageSummary) => {
      if (folderTypeById.get(message.folderId) === 'sent') {
        const recipients = collectDisplayNames([message.to])
        if (recipients.length > 0) return participantsLabel(recipients)
      }
      return extractName(message.from)
    },
    [folderTypeById]
  )

  // Flat message rows — used for search results and for unthreaded folder view.
  const buildFlatRow = useCallback(
    (message: MessageSummary, showFolder: boolean) => ({
      message,
      displayName: rowDisplayName(message),
      formattedDate: formatDate(message.date),
      folderName: showFolder ? folderNameById.get(message.folderId) ?? 'Mailbox' : null
    }),
    [folderNameById, rowDisplayName]
  )

  // Search always shows the folder; the flat folder view only shows it in unified.
  const messageRows = useMemo(
    () => searchResults.map((m) => buildFlatRow(m, true)),
    [searchResults, buildFlatRow]
  )
  const flatRows = useMemo(
    () => messages.map((m) => buildFlatRow(m, selectedFolderId === 'unified')),
    [messages, buildFlatRow, selectedFolderId]
  )

  // Thread rows (folder / unified view).
  const threadRows = useMemo(
    () =>
      threads.map((thread) => ({
        thread,
        participants: participantsLabel(thread.participants),
        formattedDate: formatDate(thread.date)
      })),
    [threads]
  )

  const selectedIdSet = useMemo(() => new Set(selectedMessageIds), [selectedMessageIds])
  // Only highlight a multi-row selection; a lone key is just the open thread.
  const selectedThreadKeySet = useMemo(
    () => new Set(selectedThreadKeys.length > 1 ? selectedThreadKeys : []),
    [selectedThreadKeys]
  )
  const expandedSet = useMemo(() => new Set(expandedThreadKeys), [expandedThreadKeys])

  const showThreads = !isSearching && threadedView
  const showFlat = !isSearching && !threadedView

  const itemCount = isSearching
    ? searchResults.length
    : threadedView
      ? threads.length
      : messages.length
  // Search isn't paginated; the folder list (threaded or flat) has "load more".
  const hasMore =
    !isSearching &&
    (threadedView ? threads.length < threadTotal : messages.length < messageTotal)

  // Keep the selected row visible during keyboard nav.
  const selectionKey = showThreads ? selectedThreadId : selectedMessageId
  const rowIndexRef = useRef<() => number>(() => -1)
  rowIndexRef.current = () =>
    showThreads
      ? threads.findIndex((t) => t.threadId === selectedThreadId)
      : (isSearching ? searchResults : messages).findIndex((m) => m.id === selectedMessageId)
  useEffect(() => {
    if (!selectionKey) return
    const idx = rowIndexRef.current()
    if (idx >= 0) vlistRef.current?.scrollToIndex(idx, { align: 'nearest' })
  }, [selectionKey])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    if (showThreads) {
      selectAdjacentThread(direction)
    } else if (event.shiftKey) {
      extendSelectionToAdjacent(direction)
    } else {
      selectAdjacentMessage(direction)
    }
  }

  const handleMessageClick = useCallback((event: React.MouseEvent, messageId: string) => {
    containerRef.current?.focus()
    if (event.shiftKey) void selectMessageRange(messageId)
    else if (event.metaKey || event.ctrlKey) void toggleMessageSelection(messageId)
    else void selectMessage(messageId)
  }, [])

  // Inline thread children are plain single-message opens (no range/multi-select).
  const handleChildClick = useCallback((_event: React.MouseEvent, messageId: string) => {
    containerRef.current?.focus()
    void selectMessage(messageId)
  }, [])

  const handleThreadClick = useCallback(
    (event: React.MouseEvent, accountId: string, threadId: string) => {
      containerRef.current?.focus()
      if (event.shiftKey) selectThreadRange(accountId, threadId)
      else if (event.metaKey || event.ctrlKey) toggleThreadSelection(accountId, threadId)
      else void selectThread(accountId, threadId)
    },
    []
  )

  const handleToggleExpand = useCallback((accountId: string, threadId: string) => {
    void toggleThreadExpanded(accountId, threadId)
  }, [])

  const handleContextMenu = useCallback((event: React.MouseEvent, message: MessageSummary) => {
    event.preventDefault()
    setContextMenu({ message, x: event.clientX, y: event.clientY })
  }, [])

  const handleThreadContextMenu = useCallback((event: React.MouseEvent, thread: ThreadSummary) => {
    event.preventDefault()
    setThreadMenu({ thread, x: event.clientX, y: event.clientY })
  }, [])

  const handleLoadMore = async () => {
    setLoadingMore(true)
    try {
      await loadMoreMessages()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to load more')
    } finally {
      setLoadingMore(false)
    }
  }

  if (loading && itemCount === 0) {
    return <EmptyState title="Loading messages…" description="Syncing your mail" />
  }

  // Folder switch in flight: skeleton rows rather than an empty/stale pane.
  if (listLoading && !isSearching && itemCount === 0) {
    return (
      <div className="message-list">
        <div className="message-list-scroller message-skeleton-list">
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="message-row message-skeleton-row" aria-hidden>
              <div className="skeleton-dot" />
              <div className="message-content">
                <div className="skeleton-line skeleton-line-sender" />
                <div className="skeleton-line skeleton-line-subject" />
                <div className="skeleton-line skeleton-line-snippet" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  // Local cache had no match and a live server search is in flight.
  if (itemCount === 0 && isSearching && searchLoading) {
    return (
      <EmptyState
        icon={<MagnifyingGlass size={40} weight="duotone" />}
        title="Searching the server…"
        description={
          searchScopeLabel
            ? `Looking for “${searchQuery.trim()}” in ${searchScopeLabel}`
            : `Looking for “${searchQuery.trim()}” on the mail server`
        }
      />
    )
  }

  if (itemCount === 0) {
    return (
      <EmptyState
        icon={
          isSearching ? (
            <MagnifyingGlass size={40} weight="duotone" />
          ) : (
            <Tray size={40} weight="duotone" />
          )
        }
        title={isSearching ? 'No results' : 'No messages'}
        description={
          isSearching
            ? searchScopeLabel
              ? `Nothing matched “${searchQuery.trim()}” in ${searchScopeLabel}`
              : `Nothing matched “${searchQuery.trim()}”`
            : 'Your inbox is clear — enjoy the calm'
        }
      />
    )
  }

  // Build a single flat array of row elements for the virtualized list. Passing
  // one clean array (never a boolean / nested-array child) keeps virtua's item
  // accounting stable.
  const listItems: React.ReactNode[] = []
  if (isSearching || showFlat) {
    for (const row of isSearching ? messageRows : flatRows) {
      listItems.push(
        <MessageRow
          key={row.message.id}
          message={row.message}
          displayName={row.displayName}
          formattedDate={row.formattedDate}
          isRead={row.message.isRead}
          isSelected={selectedIdSet.has(row.message.id)}
          isActive={selectedMessageId === row.message.id && selectedMessageIds.length > 1}
          isStarred={row.message.isStarred}
          flagColor={row.message.flagColor}
          folderName={row.folderName}
          onSelect={handleMessageClick}
          onContextMenu={handleContextMenu}
        />
      )
    }
  } else if (showThreads) {
    for (const row of threadRows) {
      const key = `${row.thread.accountId} ${row.thread.threadId}`
      const isExpanded = expandedSet.has(key)
      listItems.push(
        <ThreadRow
          key={key}
          thread={row.thread}
          participantsLabel={row.participants}
          formattedDate={row.formattedDate}
          isSelected={selectedThreadId === row.thread.threadId}
          isInSelection={selectedThreadKeySet.has(key)}
          expandable={row.thread.messageCount > 1}
          isExpanded={isExpanded}
          onSelect={handleThreadClick}
          onToggleExpand={handleToggleExpand}
          onContextMenu={handleThreadContextMenu}
        />
      )
      if (!isExpanded) continue
      const children = expandedThreadMessages[key]
      if (!children) {
        listItems.push(
          <div key={`${key}:loading`} className="thread-children-loading">
            Loading conversation…
          </div>
        )
        continue
      }
      for (const m of children) {
        listItems.push(
          <MessageRow
            key={`${key}:${m.id}`}
            message={m}
            nested
            displayName={rowDisplayName(m)}
            formattedDate={formatDate(m.date)}
            isRead={m.isRead}
            isSelected={selectedMessageId === m.id && !selectedThreadId}
            isActive={false}
            isStarred={m.isStarred}
            flagColor={m.flagColor}
            folderName={folderNameById.get(m.folderId) ?? null}
            onSelect={handleChildClick}
            onContextMenu={handleContextMenu}
          />
        )
      }
    }
  }
  if (hasMore) {
    listItems.push(
      <div className="load-more-wrap" key="__load_more__">
        <button
          className="btn btn-secondary load-more-btn"
          onClick={handleLoadMore}
          disabled={loadingMore}
        >
          {loadingMore
            ? 'Loading…'
            : threadedView
              ? `Load more (${threads.length} of ${threadTotal})`
              : `Load more (${messages.length} of ${messageTotal})`}
        </button>
      </div>
    )
  }

  return (
    <div ref={containerRef} className="message-list" tabIndex={0} onKeyDown={handleKeyDown}>
      {isSearching && (
        <div className="search-results-banner">
          <span>
            {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
            {searchScopeLabel ? ` in ${searchScopeLabel}` : ''}
            {serverSearched ? ' · searched server' : ''}
          </span>
          {searchAccountId && !serverSearched && (
            <button
              type="button"
              className="search-server-btn"
              disabled={searchLoading}
              title="Search the entire mailbox on the mail server, including older mail not synced locally"
              onClick={() => void searchWholeMailbox(searchQuery, searchAccountId)}
            >
              {searchLoading ? 'Searching server…' : 'Search whole mailbox'}
            </button>
          )}
        </div>
      )}

      <VList ref={vlistRef} className="message-list-scroller">
        {listItems}
      </VList>

      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}

      {threadMenu && (
        <ThreadContextMenu
          thread={threadMenu.thread}
          x={threadMenu.x}
          y={threadMenu.y}
          onClose={() => setThreadMenu(null)}
        />
      )}
    </div>
  )
}
