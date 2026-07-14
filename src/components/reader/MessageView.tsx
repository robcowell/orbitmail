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
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import {
  Paperclip,
  EnvelopeSimpleOpen,
  Flag,
  Sparkle,
  CaretRight,
  ArrowBendUpLeft,
  ArrowBendDoubleUpLeft,
  Printer,
  TrayArrowDown
} from '../icons'
import { flagColorHex } from '../../constants/flags'
import { printMessageDetail, printThreadDetails } from '../../utils/printMessage'

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

// "Analyze" button. When the message has attachments, opens a small menu so the
// user chooses whether to include them — attachments cost extra tokens, so it's
// an explicit opt-in. With no attachments it analyzes the body directly.
function AnalyzeButton({ message, iconSize = 16 }: { message: MessageDetail; iconSize?: number }) {
  const aiAnalysis = useMailStore((s) => s.aiAnalysisById[message.id])
  const aiAnalyzingId = useMailStore((s) => s.aiAnalyzingId)
  const isAnalyzing = aiAnalyzingId === message.id
  const hasAttachments = message.attachments.length > 0
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

  const run = (includeAttachments: boolean) => {
    setOpen(false)
    void analyzeMessage(message.id, !!aiAnalysis, includeAttachments)
  }

  const label = isAnalyzing ? 'Analyzing…' : aiAnalysis ? 'Re-analyze' : 'Analyze'
  const title = aiAnalysis ? 'Re-run AI analysis' : 'Analyze with AI'

  if (!hasAttachments) {
    return (
      <button
        type="button"
        className="reader-ai-btn"
        title={title}
        disabled={isAnalyzing}
        onClick={() => run(false)}
      >
        <Sparkle size={iconSize} weight={aiAnalysis ? 'fill' : 'duotone'} />
        {label}
      </button>
    )
  }

  return (
    <div className="draft-reply" ref={ref}>
      <button
        type="button"
        className="reader-ai-btn"
        title={title}
        disabled={isAnalyzing}
        onClick={() => setOpen((o) => !o)}
      >
        <Sparkle size={iconSize} weight={aiAnalysis ? 'fill' : 'duotone'} />
        {label}
        <CaretRight
          size={12}
          weight="bold"
          style={{ transform: 'rotate(90deg)', opacity: 0.7 }}
        />
      </button>
      {open && !isAnalyzing && (
        <div className="draft-reply-menu" role="menu">
          <button
            type="button"
            className="draft-reply-option"
            role="menuitem"
            onClick={() => run(false)}
          >
            <span className="draft-reply-option-label">Text only</span>
            <span className="draft-reply-option-hint">Message body</span>
          </button>
          <button
            type="button"
            className="draft-reply-option"
            role="menuitem"
            onClick={() => run(true)}
          >
            <span className="draft-reply-option-label">Include attachments</span>
            <span className="draft-reply-option-hint">Uses more tokens</span>
          </button>
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

  const handlePrint = async () => {
    try {
      await printMessageDetail(selectedMessage)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Print failed')
    }
  }

  const handleReply = () => {
    void window.orbitMail.compose.open({
      accountId: selectedMessage.accountId,
      mode: 'reply',
      originalMessageId: selectedMessage.id
    })
  }

  const handleReplyAll = () => {
    void window.orbitMail.compose.open({
      accountId: selectedMessage.accountId,
      mode: 'reply-all',
      originalMessageId: selectedMessage.id
    })
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
              className="reader-ai-btn primary"
              title="Reply to this message"
              onClick={handleReply}
            >
              <ArrowBendUpLeft size={16} weight="duotone" />
              Reply
            </button>
            <button
              type="button"
              className="reader-ai-btn"
              title="Reply to everyone"
              onClick={handleReplyAll}
            >
              <ArrowBendDoubleUpLeft size={16} weight="duotone" />
              Reply All
            </button>
            <DraftReplyButton messageId={selectedMessage.id} />
            <AnalyzeButton message={selectedMessage} />
            <button
              type="button"
              className="reader-ai-btn"
              title="Print this message"
              onClick={handlePrint}
            >
              <Printer size={16} weight="duotone" />
              Print
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

      <AttachmentList
        attachments={selectedMessage.attachments}
        messageId={selectedMessage.id}
      />

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

// Attachment chips shared by the single-message and thread readers. Each chip
// opens on click; a trailing button saves it to disk, and "Save all" appears
// when a message carries more than one attachment.
function AttachmentList({
  attachments,
  messageId
}: {
  attachments: MessageDetail['attachments']
  messageId: string
}) {
  const setToast = useMailStore((s) => s.setToast)
  const [busy, setBusy] = useState<{ id: string; kind: 'open' | 'save' } | null>(null)
  const [savingAll, setSavingAll] = useState(false)
  const [menu, setMenu] = useState<{
    x: number
    y: number
    att: MessageDetail['attachments'][number]
  } | null>(null)
  const anyBusy = busy !== null || savingAll

  if (attachments.length === 0) return null

  const handleOpen = async (id: string) => {
    if (anyBusy) return
    setBusy({ id, kind: 'open' })
    try {
      await window.orbitMail.attachments.open(id)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to open attachment')
    } finally {
      setBusy(null)
    }
  }

  const handleSave = async (id: string, filename: string) => {
    if (anyBusy) return
    setBusy({ id, kind: 'save' })
    try {
      const saved = await window.orbitMail.attachments.saveAs(id)
      if (saved) setToast(`Saved ${filename}`)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to save attachment')
    } finally {
      setBusy(null)
    }
  }

  const handleSaveAll = async () => {
    if (anyBusy) return
    setSavingAll(true)
    try {
      const count = await window.orbitMail.attachments.saveAll(messageId)
      if (count != null) setToast(`Saved ${count} attachment${count === 1 ? '' : 's'}`)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to save attachments')
    } finally {
      setSavingAll(false)
    }
  }

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          id: 'open',
          label: 'Open attachment',
          icon: <Paperclip size={14} weight="duotone" />,
          onClick: () => void handleOpen(menu.att.id)
        },
        {
          id: 'save',
          label: 'Save attachment…',
          icon: <TrayArrowDown size={14} weight="duotone" />,
          onClick: () => void handleSave(menu.att.id, menu.att.filename)
        },
        ...(attachments.length > 1
          ? [
              { id: 'sep', label: '', separator: true },
              {
                id: 'save-all',
                label: 'Save all attachments…',
                icon: <TrayArrowDown size={14} weight="duotone" />,
                onClick: () => void handleSaveAll()
              }
            ]
          : [])
      ]
    : []

  return (
    <div className="reader-attachments">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="attachment-item"
          onContextMenu={(event) => {
            event.preventDefault()
            event.stopPropagation()
            setMenu({ x: event.clientX, y: event.clientY, att })
          }}
        >
          <button
            type="button"
            className="attachment-chip"
            disabled={anyBusy}
            onClick={() => void handleOpen(att.id)}
            title="Open attachment"
          >
            <Paperclip size={14} weight="duotone" />
            {busy?.id === att.id && busy.kind === 'open' ? 'Opening…' : att.filename}
            <span style={{ color: 'var(--text-muted)' }}>({formatSize(att.size)})</span>
          </button>
          <button
            type="button"
            className="attachment-save-btn"
            disabled={anyBusy}
            onClick={() => void handleSave(att.id, att.filename)}
            title="Save attachment…"
          >
            <TrayArrowDown size={14} weight="duotone" />
          </button>
        </div>
      ))}
      {attachments.length > 1 && (
        <button
          type="button"
          className="attachment-save-all-btn"
          disabled={anyBusy}
          onClick={() => void handleSaveAll()}
          title="Save all attachments…"
        >
          <TrayArrowDown size={14} weight="duotone" />
          {savingAll ? 'Saving…' : 'Save all'}
        </button>
      )}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}

// ---- Conversation (thread) reader ----------------------------------------

function ThreadView({ messages }: { messages: MessageDetail[] }) {
  const setToast = useMailStore((s) => s.setToast)
  const latest = messages[messages.length - 1]

  const handleReply = () => {
    void window.orbitMail.compose.open({
      accountId: latest.accountId,
      mode: 'reply',
      originalMessageId: latest.id
    })
  }

  const handleReplyAll = () => {
    void window.orbitMail.compose.open({
      accountId: latest.accountId,
      mode: 'reply-all',
      originalMessageId: latest.id
    })
  }

  const handlePrint = async () => {
    try {
      await printThreadDetails(messages)
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Print failed')
    }
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
              className="reader-ai-btn primary"
              title="Reply to the latest message"
              onClick={handleReply}
            >
              <ArrowBendUpLeft size={16} weight="duotone" />
              Reply
            </button>
            <button
              type="button"
              className="reader-ai-btn"
              title="Reply to everyone"
              onClick={handleReplyAll}
            >
              <ArrowBendDoubleUpLeft size={16} weight="duotone" />
              Reply All
            </button>
            <button
              type="button"
              className="reader-ai-btn"
              title="Print this conversation"
              onClick={handlePrint}
            >
              <Printer size={16} weight="duotone" />
              Print
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
          <AnalyzeButton message={message} iconSize={14} />
          <span className="thread-msg-date">{new Date(message.date).toLocaleString()}</span>
        </div>
      </div>

      <AttachmentList attachments={message.attachments} messageId={message.id} />

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
