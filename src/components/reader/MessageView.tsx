import { memo, useEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import type { DraftTone, MessageDetail } from '../../../shared/types'
import {
  useMailStore,
  toggleMessageStar,
  toggleThreadMessageStar,
  analyzeMessage,
  draftReply
} from '../../stores/mailStore'
import { EmptyState } from '../EmptyState'
import { MessageContextMenu } from '../messages/MessageContextMenu'
import {
  Paperclip,
  EnvelopeSimpleOpen,
  Flag,
  Sparkle,
  CaretRight,
  ArrowBendUpLeft
} from '../icons'
import { flagColorHex } from '../../constants/flags'

function extractName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  if (match) return match[1].replace(/"/g, '').trim()
  return from
}

const DRAFT_TONES: { value: DraftTone; label: string; hint: string }[] = [
  { value: 'brief', label: 'Brief', hint: '2–4 sentences' },
  { value: 'neutral', label: 'Neutral', hint: 'Standard length' },
  { value: 'detailed', label: 'Detailed', hint: 'Thorough' }
]

// "Draft reply ▾" split-button: pick a tone, generate a draft, open the composer.
function DraftReplyButton({ messageId }: { messageId: string }) {
  const draftingReplyId = useMailStore((s) => s.draftingReplyId)
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const isDrafting = draftingReplyId === messageId

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const pick = (tone: DraftTone) => {
    setOpen(false)
    void draftReply(messageId, tone)
  }

  return (
    <div className="draft-reply" ref={ref}>
      <button
        type="button"
        className="reader-ai-btn"
        disabled={isDrafting}
        title="Draft an AI reply"
        onClick={() => setOpen((o) => !o)}
      >
        <Sparkle size={16} weight="duotone" />
        {isDrafting ? 'Drafting…' : 'Draft reply'}
        <CaretRight
          size={12}
          weight="bold"
          style={{ transform: 'rotate(90deg)', opacity: 0.7 }}
        />
      </button>
      {open && !isDrafting && (
        <div className="draft-reply-menu" role="menu">
          {DRAFT_TONES.map((t) => (
            <button
              key={t.value}
              type="button"
              className="draft-reply-option"
              role="menuitem"
              onClick={() => pick(t.value)}
            >
              <span className="draft-reply-option-label">{t.label}</span>
              <span className="draft-reply-option-hint">{t.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function MessageView() {
  const selectedMessage = useMailStore((s) => s.selectedMessage)
  const selectedMessageId = useMailStore((s) => s.selectedMessageId)
  const selectionCount = useMailStore((s) => s.selectedMessageIds.length)
  const selectedThread = useMailStore((s) => s.selectedThread)
  const threadLoading = useMailStore((s) => s.threadLoading)
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

  // Conversation mode: a thread is open (takes priority over single-message).
  if (selectedThread && selectedThread.length > 0) {
    return <ThreadView messages={selectedThread} />
  }
  if (threadLoading && !selectedThread) {
    return (
      <EmptyState
        icon={<EnvelopeSimpleOpen size={48} weight="duotone" />}
        title="Loading conversation…"
        description="Fetching the full thread"
      />
    )
  }

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
            <DraftReplyButton messageId={selectedMessage.id} />
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

// ---- Conversation (thread) reader ----------------------------------------

function ThreadView({ messages }: { messages: MessageDetail[] }) {
  const latest = messages[messages.length - 1]

  const handleReply = () => {
    void window.orbitMail.compose.open({
      accountId: latest.accountId,
      mode: 'reply',
      originalMessageId: latest.id
    })
  }

  return (
    <div>
      <div className="reader-header">
        <div className="reader-header-top">
          <div className="reader-subject">
            {latest.subject}
            {messages.length > 1 && (
              <span className="reader-thread-count">{messages.length} messages</span>
            )}
          </div>
          <div className="reader-header-actions">
            <button
              type="button"
              className="reader-ai-btn"
              title="Reply to the latest message"
              onClick={handleReply}
            >
              <ArrowBendUpLeft size={16} weight="duotone" />
              Reply
            </button>
            <DraftReplyButton messageId={latest.id} />
          </div>
        </div>
      </div>

      <div className="thread-conversation">
        {messages.map((message, i) => (
          <ThreadMessage
            key={message.id}
            message={message}
            defaultExpanded={i === messages.length - 1 || !message.isRead}
          />
        ))}
      </div>
    </div>
  )
}

const ThreadMessage = memo(function ThreadMessage({
  message,
  defaultExpanded
}: {
  message: MessageDetail
  defaultExpanded: boolean
}) {
  const setToast = useMailStore((s) => s.setToast)
  const aiAnalysis = useMailStore((s) => s.aiAnalysisById[message.id])
  const aiAnalyzingId = useMailStore((s) => s.aiAnalyzingId)
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [fetchingAttachmentId, setFetchingAttachmentId] = useState<string | null>(null)
  const isAnalyzing = aiAnalyzingId === message.id

  const sanitizedHtml = useMemo(() => {
    if (!message.bodyHtml) return null
    return DOMPurify.sanitize(message.bodyHtml, {
      ADD_ATTR: ['target', 'href'],
      FORBID_TAGS: ['script', 'style']
    })
  }, [message.id, message.bodyHtml])

  const handleBodyClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement).closest('a')
    if (!anchor) return
    const href = anchor.getAttribute('href')
    if (!href || href.startsWith('#')) return
    event.preventDefault()
    void window.orbitMail.shell.openExternal(href)
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

  if (!expanded) {
    return (
      <div className="thread-msg" onClick={() => setExpanded(true)}>
        <div className="thread-msg-head">
          <span className="thread-msg-from">{extractName(message.from)}</span>
          <span className="thread-msg-preview">{message.snippet}</span>
          <span className="thread-msg-date">
            {(message.flagColor || message.isStarred) && (
              <Flag
                size={12}
                weight="fill"
                style={{ color: flagColorHex(message.flagColor) ?? '#f5a623' }}
              />
            )}
            {new Date(message.date).toLocaleDateString()}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="thread-msg is-open">
      <div className="thread-msg-head" onClick={() => setExpanded(false)}>
        <div className="thread-msg-head-main">
          <span className="thread-msg-from">{message.from}</span>
          <span className="thread-msg-to">to {message.to}</span>
        </div>
        <div className="thread-msg-head-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className={`reader-star-btn${message.isStarred ? ' active' : ''}`}
            title={message.isStarred ? 'Remove star' : 'Star message'}
            onClick={() => void toggleThreadMessageStar(message.id, !message.isStarred)}
          >
            <Flag
              size={16}
              weight="fill"
              style={{ color: flagColorHex(message.flagColor) ?? '#f5a623' }}
            />
          </button>
          <button
            type="button"
            className="reader-ai-btn"
            title={aiAnalysis ? 'Re-run AI analysis' : 'Analyze with AI'}
            disabled={isAnalyzing}
            onClick={() => void analyzeMessage(message.id, !!aiAnalysis)}
          >
            <Sparkle size={14} weight={aiAnalysis ? 'fill' : 'duotone'} />
            {isAnalyzing ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze'}
          </button>
          <span className="thread-msg-date">{new Date(message.date).toLocaleString()}</span>
        </div>
      </div>

      {message.attachments.length > 0 && (
        <div className="reader-attachments">
          {message.attachments.map((att) => (
            <button
              key={att.id}
              className="attachment-chip"
              disabled={fetchingAttachmentId === att.id}
              onClick={() => void handleOpenAttachment(att.id)}
            >
              <Paperclip size={14} weight="duotone" />
              {fetchingAttachmentId === att.id ? 'Opening…' : att.filename}
              <span style={{ color: 'var(--text-muted)' }}>({formatSize(att.size)})</span>
            </button>
          ))}
        </div>
      )}

      {(aiAnalysis || isAnalyzing) && (
        <div className="reader-ai-panel">
          <div className="reader-ai-panel-header">
            <Sparkle size={14} weight="fill" />
            <span>AI Analysis</span>
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

      <div className="reader-body thread-msg-body" onClick={handleBodyClick}>
        {sanitizedHtml ? (
          <div dangerouslySetInnerHTML={{ __html: sanitizedHtml }} />
        ) : (
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>
            {message.bodyText ?? 'No content'}
          </pre>
        )}
      </div>
    </div>
  )
})
