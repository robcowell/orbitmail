import { useState } from 'react'
import DOMPurify from 'dompurify'
import { useMailStore, toggleMessageStar } from '../../stores/mailStore'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import { Paperclip, EnvelopeSimpleOpen, Flag } from '../icons'
import { flagColorHex } from '../../constants/flags'

export function MessageView() {
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const setToast = useMailStore((s) => s.setToast)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)

  if (!selectedMessageId || !selectedMessage) {
    return (
      <EmptyState
        icon={<EnvelopeSimpleOpen size={48} weight="duotone" />}
        title="Select a message"
        description="Choose a conversation from the list to read it here"
      />
    )
  }

  const sanitizedHtml = selectedMessage.bodyHtml
    ? DOMPurify.sanitize(selectedMessage.bodyHtml, {
        ADD_ATTR: ['target', 'href'],
        FORBID_TAGS: ['script', 'style']
      })
    : null

  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    const anchor = target.closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#')) return
    event.preventDefault()
    void window.orbitMail.shell.openExternal(href)
  }

  const handleToggleStar = async () => {
    try {
      await toggleMessageStar(selectedMessage.id, !selectedMessage.isStarred)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Update failed')
    }
  }

  return (
    <div
      onContextMenu={(event) => {
        event.preventDefault()
        setContextMenu({ x: event.clientX, y: event.clientY })
      }}
    >
      <div className="reader-header">
        <div className="reader-header-top">
          <div className="reader-subject">{selectedMessage.subject}</div>
          <button
            type="button"
            className={`reader-star-btn${selectedMessage.isStarred ? ' active' : ''}`}
            title={selectedMessage.isStarred ? 'Remove star' : 'Star message'}
            onClick={handleToggleStar}
          >
            <Flag
              size={18}
              weight="fill"
              style={{ color: flagColorHex(selectedMessage.flagColor) ?? '#f5a623' }}
            />
          </button>
        </div>
        <div className="reader-meta">
          <div>
            <strong>From:</strong> {selectedMessage.from}
          </div>
          <div>
            <strong>To:</strong> {selectedMessage.to}
          </div>
          {selectedMessage.cc && (
            <div>
              <strong>Cc:</strong> {selectedMessage.cc}
            </div>
          )}
          <div>
            <strong>Date:</strong>{' '}
            {new Date(selectedMessage.date).toLocaleString()}
          </div>
        </div>
      </div>

      {selectedMessage.attachments.length > 0 && (
        <div className="reader-attachments">
          {selectedMessage.attachments.map((att) => (
            <button
              key={att.id}
              className="attachment-chip"
              onClick={() => window.orbitMail.attachments.open(att.id)}
            >
              <Paperclip size={14} weight="duotone" />
              {att.filename}
              <span style={{ color: 'var(--text-muted)' }}>
                ({formatSize(att.size)})
              </span>
            </button>
          ))}
        </div>
      )}

      <div className="reader-body" onClick={handleBodyClick}>
        {sanitizedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {selectedMessage.bodyText ?? 'No content'}
          </pre>
        )}
      </div>

      {contextMenu && (
        <MessageContextMenu
          message={selectedMessage}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
