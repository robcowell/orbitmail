import DOMPurify from 'dompurify'
import { useMailStore } from '../../stores/mailStore'
import { EmptyState } from '../EmptyState'
import { Paperclip, EnvelopeSimpleOpen } from '../icons'

export function MessageView() {
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)

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
        ADD_ATTR: ['target'],
        FORBID_TAGS: ['script', 'style']
      })
    : null

  return (
    <div>
      <div className="reader-header">
        <div className="reader-subject">{selectedMessage.subject}</div>
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

      <div className="reader-body">
        {sanitizedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {selectedMessage.bodyText ?? 'No content'}
          </pre>
        )}
      </div>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
