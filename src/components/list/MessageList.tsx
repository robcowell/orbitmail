import { useEffect, useMemo, useRef, useState } from 'react'
import type { MessageSummary } from '../../../shared/types'
import {
  useMailStore,
  selectMessage,
  selectAdjacentMessage,
  extendSelectionToAdjacent,
  selectMessageRange,
  toggleMessageSelection,
  loadMoreMessages
} from '../../stores/mailStore'
import { resolveSearchAccountId, searchAccountLabel } from '../../utils/search'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import { flagColorHex } from '../../constants/flags'
import { Tray, Flag, MagnifyingGlass } from '../icons'

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

export function MessageList() {
  const messages = useMailStore((s) => s.messages)
  const messageTotal = useMailStore((s) => s.messageTotal)
  const searchQuery = useMailStore((s) => s.searchQuery)
  const searchResults = useMailStore((s) => s.searchResults)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectedMessageIds = useMailStore((s) => s.selectedMessageIds)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const folders = useMailStore((s) => s.folders)
  const accounts = useMailStore((s) => s.accounts)
  const loading = useMailStore((s) => s.loading)
  const setToast = useMailStore((s) => s.setToast)
  const [loadingMore, setLoadingMore] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    message: MessageSummary
    x: number
    y: number
  } | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedRowRef = useRef<HTMLDivElement>(null)

  // Keep the selected row visible as the user navigates with the keyboard.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedMessageId])

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const direction = event.key === 'ArrowDown' ? 1 : -1
    if (event.shiftKey) {
      extendSelectionToAdjacent(direction)
    } else {
      selectAdjacentMessage(direction)
    }
  }

  const handleRowClick = (event: React.MouseEvent, messageId: string) => {
    containerRef.current?.focus()
    if (event.shiftKey) {
      void selectMessageRange(messageId)
    } else if (event.metaKey || event.ctrlKey) {
      void toggleMessageSelection(messageId)
    } else {
      void selectMessage(messageId)
    }
  }

  const isSearching = searchQuery.trim().length > 0
  const displayMessages = isSearching ? searchResults : messages
  const hasMore = !isSearching && messages.length < messageTotal
  const searchAccountId = resolveSearchAccountId(selectedFolderId, folders)
  const searchScopeLabel = searchAccountLabel(searchAccountId, accounts)

  const folderNameById = useMemo(
    () => new Map(folders.map((folder) => [folder.id, folder.name])),
    [folders]
  )

  if (loading && displayMessages.length === 0) {
    return <EmptyState title="Loading messages…" description="Syncing your mail" />
  }

  if (displayMessages.length === 0) {
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

  const handleContextMenu = (event: React.MouseEvent, message: MessageSummary) => {
    event.preventDefault()
    setContextMenu({
      message,
      x: event.clientX,
      y: event.clientY
    })
  }

  return (
    <div ref={containerRef} className="message-list" tabIndex={0} onKeyDown={handleKeyDown}>
      {isSearching && (
        <div className="search-results-banner">
          {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
          {searchScopeLabel ? ` in ${searchScopeLabel}` : ''}
        </div>
      )}

      {displayMessages.map((msg) => (
        <div
          key={msg.id}
          ref={selectedMessageId === msg.id ? selectedRowRef : undefined}
          className={[
            'message-row',
            !msg.isRead ? 'unread' : '',
            selectedMessageIds.includes(msg.id) ? 'selected' : '',
            selectedMessageId === msg.id && selectedMessageIds.length > 1 ? 'active' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onMouseDown={(event) => {
            // Stop Shift+click from selecting the row text as a side effect.
            if (event.shiftKey) event.preventDefault()
          }}
          onClick={(event) => handleRowClick(event, msg.id)}
          onContextMenu={(event) => handleContextMenu(event, msg)}
        >
          <div className={`unread-dot${msg.isRead ? ' read' : ''}`} />
          <div className="message-content">
            <div className="message-top">
              <span className="message-sender">{extractName(msg.from)}</span>
              <span className="message-date">
                {(msg.flagColor || msg.isStarred) && (
                  <Flag
                    size={12}
                    weight="fill"
                    className="message-star"
                    style={{ color: flagColorHex(msg.flagColor) ?? '#f5a623' }}
                  />
                )}
                {formatDate(msg.date)}
              </span>
            </div>
            <div className="message-subject">{msg.subject}</div>
            {isSearching && (
              <div className="message-folder">{folderNameById.get(msg.folderId) ?? 'Mailbox'}</div>
            )}
            <div className="message-snippet">{msg.snippet}</div>
          </div>
        </div>
      ))}

      {hasMore && (
        <div className="load-more-wrap">
          <button
            className="btn btn-secondary load-more-btn"
            onClick={handleLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? 'Loading…' : `Load more (${messages.length} of ${messageTotal})`}
          </button>
        </div>
      )}

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
