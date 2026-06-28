import { useMailStore, selectMessage } from '../../stores/mailStore'

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
  const searchQuery = useMailStore((s) => s.searchQuery)
  const searchResults = useMailStore((s) => s.searchResults)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const loading = useMailStore((s) => s.loading)

  const displayMessages = searchQuery.trim() ? searchResults : messages

  if (loading && displayMessages.length === 0) {
    return (
      <div className="reader-empty" style={{ height: '200px' }}>
        Loading messages…
      </div>
    )
  }

  if (displayMessages.length === 0) {
    return (
      <div className="reader-empty" style={{ height: '200px' }}>
        No messages
      </div>
    )
  }

  return (
    <div>
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
        >
          <div className={`unread-dot${msg.isRead ? ' read' : ''}`} />
          <div className="message-content">
            <div className="message-top">
              <span className="message-sender">{extractName(msg.from)}</span>
              <span className="message-date">{formatDate(msg.date)}</span>
            </div>
            <div className="message-subject">{msg.subject}</div>
            <div className="message-snippet">{msg.snippet}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
