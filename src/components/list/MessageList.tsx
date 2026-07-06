import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VList, type VListHandle } from 'virtua'
import type { FlagColor, MessageSummary, ThreadSummary } from '../../../shared/types'
import {
  useMailStore,
  selectMessage,
  selectAdjacentMessage,
  extendSelectionToAdjacent,
  selectMessageRange,
  toggleMessageSelection,
  selectThread,
  selectAdjacentThread,
  loadMoreMessages
} from '../../stores/mailStore'
import { resolveSearchAccountId, searchAccountLabel } from '../../utils/search'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import { flagColorHex } from '../../constants/flags'
import { Tray, Flag, Paperclip, MagnifyingGlass } from '../icons'

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

function extractName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  if (match) return match[1].replace(/"/g, '').trim()
  return from
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
  onSelect,
  onContextMenu
}: MessageRowProps) {
  const className = [
    'message-row',
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
  onSelect: (accountId: string, threadId: string) => void
}

const ThreadRow = memo(function ThreadRow({
  thread,
  participantsLabel,
  formattedDate,
  isSelected,
  onSelect
}: ThreadRowProps) {
  const className = [
    'message-row',
    thread.hasUnread ? 'unread' : '',
    isSelected ? 'selected' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={className} onClick={() => onSelect(thread.accountId, thread.threadId)}>
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
  const threads = useMailStore((s) => s.threads)
  const threadTotal = useMailStore((s) => s.threadTotal)
  const selectedThreadId = useMailStore((s) => s.selectedThreadId)
  const searchQuery = useMailStore((s) => s.searchQuery)
  const searchResults = useMailStore((s) => s.searchResults)
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
  const containerRef = useRef<HTMLDivElement>(null)
  const vlistRef = useRef<VListHandle>(null)

  const isSearching = searchQuery.trim().length > 0
  const searchAccountId = resolveSearchAccountId(selectedFolderId, folders)
  const searchScopeLabel = searchAccountLabel(searchAccountId, accounts)

  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders]
  )

  // Search rows (flat messages).
  const messageRows = useMemo(
    () =>
      searchResults.map((message) => ({
        message,
        displayName: extractName(message.from),
        formattedDate: formatDate(message.date),
        folderName: folderNameById.get(message.folderId) ?? 'Mailbox'
      })),
    [searchResults, folderNameById]
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

  const itemCount = isSearching ? searchResults.length : threads.length
  // Search isn't paginated; only the thread list has "load more".
  const hasMore = !isSearching && threads.length < threadTotal

  // Keep the selected row visible during keyboard nav.
  const selectionKey = isSearching ? selectedMessageId : selectedThreadId
  const rowIndexRef = useRef<() => number>(() => -1)
  rowIndexRef.current = () =>
    isSearching
      ? searchResults.findIndex((m) => m.id === selectedMessageId)
      : threads.findIndex((t) => t.threadId === selectedThreadId)
  useEffect(() => {
    if (!selectionKey) return
    const idx = rowIndexRef.current()
    if (idx >= 0) vlistRef.current?.scrollToIndex(idx, { align: 'nearest' })
  }, [selectionKey])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    if (isSearching) {
      if (event.shiftKey) extendSelectionToAdjacent(direction)
      else selectAdjacentMessage(direction)
    } else {
      selectAdjacentThread(direction)
    }
  }

  const handleMessageClick = useCallback((event: React.MouseEvent, messageId: string) => {
    containerRef.current?.focus()
    if (event.shiftKey) void selectMessageRange(messageId)
    else if (event.metaKey || event.ctrlKey) void toggleMessageSelection(messageId)
    else void selectMessage(messageId)
  }, [])

  const handleThreadClick = useCallback((accountId: string, threadId: string) => {
    containerRef.current?.focus()
    void selectThread(accountId, threadId)
  }, [])

  const handleContextMenu = useCallback((event: React.MouseEvent, message: MessageSummary) => {
    event.preventDefault()
    setContextMenu({ message, x: event.clientX, y: event.clientY })
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

  return (
    <div ref={containerRef} className="message-list" tabIndex={0} onKeyDown={handleKeyDown}>
      {isSearching && (
        <div className="search-results-banner">
          {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
          {searchScopeLabel ? ` in ${searchScopeLabel}` : ''}
        </div>
      )}

      <VList ref={vlistRef} className="message-list-scroller">
        {isSearching
          ? messageRows.map((row) => (
              <MessageRow
                key={row.message.id}
                message={row.message}
                displayName={row.displayName}
                formattedDate={row.formattedDate}
                isRead={row.message.isRead}
                isSelected={selectedIdSet.has(row.message.id)}
                isActive={
                  selectedMessageId === row.message.id && selectedMessageIds.length > 1
                }
                isStarred={row.message.isStarred}
                flagColor={row.message.flagColor}
                folderName={row.folderName}
                onSelect={handleMessageClick}
                onContextMenu={handleContextMenu}
              />
            ))
          : threadRows.map((row) => (
              <ThreadRow
                key={`${row.thread.accountId} ${row.thread.threadId}`}
                thread={row.thread}
                participantsLabel={row.participants}
                formattedDate={row.formattedDate}
                isSelected={selectedThreadId === row.thread.threadId}
                onSelect={handleThreadClick}
              />
            ))}

        {hasMore && (
          <div className="load-more-wrap" key="__load_more__">
            <button
              className="btn btn-secondary load-more-btn"
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : `Load more (${threads.length} of ${threadTotal})`}
            </button>
          </div>
        )}
      </VList>

      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
