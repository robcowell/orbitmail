import { useMemo, useState } from 'react'
import DOMPurify from 'dompurify'
import { useMailStore, toggleMessageStar, analyzeMessage } from '../../stores/mailStore'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import { Paperclip, EnvelopeSimpleOpen, Flag, Sparkle } from '../icons'
import { flagColorHex } from '../../constants/flags'

export function MessageView() {
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectionCount = useMailStore((s) => s.selectedMessageIds.length)
  const readerLoading = useMailStore((s) => s.readerLoading)
  const setToast = useMailStore((s) => s.setToast)
  const aiAnalysis = useMailStore((s) =>
    selectedMessageId ? s.aiAnalysisById[selectedMessageId] : undefined
  )
  const aiAnalyzingId = useMailStore((s) => s.aiAnalyzingId)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [fetchingAttachmentId, setFetchingAttachmentId] = useState<string | null>(null)

  // Sanitizing a large email is expensive; only redo it when the message body
  // actually changes, not on every unrelated store update (star, AI, selection).
  const sanitizedHtml = useMemo(() => {
    if (!selectedMessage?.bodyHtml) return null
    return DOMPurify.sanitize(selectedMessage.bodyHtml, {
      ADD_ATTR: ['target', 'href'],
      FORBID_TAGS: ['script', 'style']
    })
  }, [selectedMessage?.id, selectedMessage?.bodyHtml])

  if (selectionCount > 1) {
    return (
      <EmptyState
        icon={<EnvelopeSimpleOpen size={48} weight="duotone" />}
        title={`${selectionCount} messages selected`}
        description="Press Delete to move them to Trash, or select a single message to read it"
      />
    )
  }

  if (!selectedMessageId || !selectedMessage) {
    return (
      <EmptyState
        icon={<EnvelopeSimpleOpen size={48} weight="duotone" />}
        title="Select a message"
        description="Choose a conversation from the list to read it here"
      />
    )
  }

  const isAnalyzing = aiAnalyzingId === selectedMessageId

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

  const handleOpenAttachment = async (attachmentId: string) => {
    if (fetchingAttachmentId) return

    setFetchingAttachmentId(attachmentId)
    try {
      await window.orbitMail.attachments.open(attachmentId)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to open attachment')
    } finally {
      setFetchingAttachmentId(null)
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
          <div className="reader-header-actions">
            <button
              type="button"
              className="reader-ai-btn"
              title={aiAnalysis ? 'Re-run AI analysis' : 'Analyze with AI'}
              disabled={isAnalyzing}
              onClick={() => void analyzeMessage(selectedMessage.id, !!aiAnalysis)}
            >
              <Sparkle size={16} weight={aiAnalysis ? 'fill' : 'duotone'} />
              {isAnalyzing ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze'}
            </button>
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
              disabled={fetchingAttachmentId === att.id}
              onClick={() => void handleOpenAttachment(att.id)}
            >
              <Paperclip size={14} weight="duotone" />
              {fetchingAttachmentId === att.id ? 'Opening…' : att.filename}
              <span style={{ color: 'var(--text-muted)' }}>
                ({formatSize(att.size)})
              </span>
            </button>
          ))}
        </div>
      )}

      {(aiAnalysis || isAnalyzing) && (
        <div className="reader-ai-panel">
          <div className="reader-ai-panel-header">
            <Sparkle size={14} weight="fill" />
            <span>AI Analysis</span>
            {aiAnalysis && !isAnalyzing && (
              <button
                type="button"
                className="reader-ai-regenerate"
                onClick={() => void analyzeMessage(selectedMessage.id, true)}
              >
                Regenerate
              </button>
            )}
          </div>
          {isAnalyzing && !aiAnalysis ? (
            <div className="reader-ai-loading">Analyzing this message…</div>
          ) : aiAnalysis ? (
            <div className="reader-ai-body">
              <p className="reader-ai-summary">{aiAnalysis.summary}</p>
              <AiSection title="Action Items" items={aiAnalysis.actionItems} />
              <AiSection title="Questions" items={aiAnalysis.questions} />
              <AiSection title="Key Context" items={aiAnalysis.keyContext} />
            </div>
          ) : null}
        </div>
      )}

      <div className="reader-body" onClick={handleBodyClick}>
        {sanitizedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : readerLoading && !selectedMessage.bodyText ? (
          <div className="reader-body-loading">Loading message…</div>
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

function AiSection({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null
  return (
    <div className="reader-ai-section">
      <div className="reader-ai-section-title">{title}</div>
      <ul>
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
