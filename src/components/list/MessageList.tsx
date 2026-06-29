import { useMemo, useState } from 'react'
import type { MessageSummary } from '../../../shared/types'
import { useMailStore, selectMessage, loadMoreMessages } from '../../stores/mailStore'
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
    <div>
      {isSearching && (
        <div className="search-results-banner">
          {searchResults.length} result{searchResults.length === 1 ? '' : 's'}
          {searchScopeLabel ? ` in ${searchScopeLabel}` : ''}
        </div>
      )}

      {displayMessages.map((msg) => (
        <div
          key={msg.id}
          className={[
            'message-row',
            !msg.isRead ? 'unread' : '',
            selectedMessageId === msg.id ? 'selected' : ''
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => selectMessage(msg.id)}
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
