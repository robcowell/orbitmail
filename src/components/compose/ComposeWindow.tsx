import { useState, useEffect, useRef } from 'react'
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml'
import { Paperclip } from '@phosphor-icons/react/dist/ssr/Paperclip'
import { X } from '@phosphor-icons/react/dist/ssr/X'
import { CaretRight } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { FileText } from '@phosphor-icons/react/dist/ssr/FileText'
import { FileImage } from '@phosphor-icons/react/dist/ssr/FileImage'
import { FilePdf } from '@phosphor-icons/react/dist/ssr/FilePdf'
import { FileZip } from '@phosphor-icons/react/dist/ssr/FileZip'
import { FileDoc } from '@phosphor-icons/react/dist/ssr/FileDoc'
import { FileXls } from '@phosphor-icons/react/dist/ssr/FileXls'
import { File as FileIcon } from '@phosphor-icons/react/dist/ssr/File'
import type { AttachmentDraft, ComposePayload } from '../../../shared/types'
import { useMailStore } from '../../stores/mailStore'
import { loadInitialData } from '../../stores/mailStore'
import { RichTextEditor } from './RichTextEditor'
import { formatBytes } from '../../utils/format'

const emptyPayload = (accountId: string): ComposePayload => ({
  accountId,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  bodyHtml: '',
  bodyText: ''
})

function attachmentIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic'].includes(ext)) return FileImage
  if (ext === 'pdf') return FilePdf
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return FileZip
  if (['doc', 'docx', 'odt', 'rtf'].includes(ext)) return FileDoc
  if (['xls', 'xlsx', 'csv', 'ods'].includes(ext)) return FileXls
  if (['txt', 'md', 'log'].includes(ext)) return FileText
  return FileIcon
}

export function ComposeWindow() {
  const accounts = useMailStore((s) => s.accounts)
  const setToast = useMailStore((s) => s.setToast)
  const [payload, setPayload] = useState<ComposePayload | null>(null)
  const [sending, setSending] = useState(false)
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [quoted, setQuoted] = useState<{ html: string; text: string } | null>(null)
  const [quotedExpanded, setQuotedExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [editorSeq, setEditorSeq] = useState(0)

  // Editor content lives in the DOM (uncontrolled); mirror it into refs so we can
  // read the latest value at send time without re-rendering on every keystroke.
  const bodyHtmlRef = useRef('')
  const bodyTextRef = useRef('')

  useEffect(() => {
    void loadInitialData()
  }, [])

  useEffect(() => {
    const unsub = window.orbitMail.compose.onOpen((initial) => {
      const accountId = initial.accountId ?? accounts[0]?.id ?? ''
      setPayload({ ...emptyPayload(accountId), ...initial })
      bodyHtmlRef.current = initial.bodyHtml ?? ''
      bodyTextRef.current = initial.bodyText ?? ''
      setEditorSeq((n) => n + 1)
      // Sanitize the quoted original once, here, so both the preview and the
      // sent body use the safe version. The raw HTML is the sender's — sending
      // it verbatim would carry their scripts/navigation sinks and, worse, their
      // remote trackers into our reply and the Sent copy. blockRemoteContent
      // strips remote images/backgrounds, matching how the reader renders them.
      setQuoted(
        initial.quotedHtml || initial.quotedText
          ? {
              html: sanitizeEmailHtml(initial.quotedHtml ?? '', { blockRemoteContent: true }) ?? '',
              text: initial.quotedText ?? ''
            }
          : null
      )
      setQuotedExpanded(false)
      if (initial.cc) setShowCc(true)
      if (initial.bcc) setShowBcc(true)
      const paths = initial.attachmentPaths ?? []
      if (paths.length) {
        void window.orbitMail.compose.statAttachments(paths).then(setAttachments)
      } else {
        setAttachments([])
      }
    })
    return unsub
  }, [accounts])

  if (!payload) {
    return (
      <div className="reader-empty" style={{ height: '100%' }}>
        New Message
      </div>
    )
  }

  const update = (patch: Partial<ComposePayload>) =>
    setPayload((p) => (p ? { ...p, ...patch } : p))

  const addDrafts = (drafts: AttachmentDraft[]) => {
    if (drafts.length === 0) return
    setAttachments((current) => {
      const seen = new Set(current.map((a) => a.path))
      return [...current, ...drafts.filter((d) => !seen.has(d.path))]
    })
  }

  const handlePickAttachments = async () => {
    addDrafts(await window.orbitMail.compose.pickAttachments())
  }

  const handleRemoveAttachment = (path: string) => {
    setAttachments((current) => current.filter((a) => a.path !== path))
  }

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    // Main resolves and approves each dropped file, and hands back the draft it
    // stat'd itself — the renderer never names a path.
    try {
      const drafts = await Promise.all(
        Array.from(e.dataTransfer.files).map((file) =>
          window.orbitMail.compose.attachDroppedFile(file)
        )
      )
      addDrafts(drafts.filter((d): d is AttachmentDraft => d !== null))
    } catch {
      setToast('Could not attach those files')
    }
  }

  const handleSend = async () => {
    if (!payload.to.trim()) {
      setToast('Please enter a recipient')
      return
    }
    if (sending) return
    const bodyHtml = quoted
      ? `${bodyHtmlRef.current}<br><br>${quoted.html}`
      : bodyHtmlRef.current
    const bodyText = quoted
      ? `${bodyTextRef.current}\n\n${quoted.text}`
      : bodyTextRef.current
    setSending(true)
    try {
      await window.orbitMail.compose.send({
        accountId: payload.accountId,
        to: payload.to,
        cc: showCc ? payload.cc : undefined,
        bcc: showBcc ? payload.bcc : undefined,
        subject: payload.subject,
        bodyHtml,
        bodyText,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        mode: payload.mode,
        originalMessageId: payload.originalMessageId,
        attachmentPaths: attachments.length ? attachments.map((a) => a.path) : undefined
      })
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to send')
      setSending(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSend()
    }
  }

  const displayAccounts =
    accounts.length > 0
      ? accounts
      : payload.accountId
        ? [{ id: payload.accountId, email: payload.accountId, displayName: payload.accountId, provider: 'imap' as const }]
        : []

  return (
    <div
      className={`compose-form${dragging ? ' is-dragging' : ''}`}
      onKeyDown={handleKeyDown}
      onDragOver={(e) => {
        e.preventDefault()
        if (!dragging) setDragging(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false)
      }}
      onDrop={handleDrop}
    >
      <div className="compose-field">
        <span className="compose-label">From</span>
        <select
          className="compose-input"
          value={payload.accountId}
          onChange={(e) => update({ accountId: e.target.value })}
        >
          {displayAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </div>

      <div className="compose-field">
        <span className="compose-label">To</span>
        <input
          className="compose-input"
          value={payload.to}
          onChange={(e) => update({ to: e.target.value })}
          placeholder="Recipient"
        />
        <button
          className="toolbar-btn compose-cc-toggle"
          onClick={() => setShowCc(!showCc)}
        >
          Cc
        </button>
        <button
          className="toolbar-btn compose-cc-toggle"
          onClick={() => setShowBcc(!showBcc)}
        >
          Bcc
        </button>
      </div>

      {showCc && (
        <div className="compose-field">
          <span className="compose-label">Cc</span>
          <input
            className="compose-input"
            value={payload.cc ?? ''}
            onChange={(e) => update({ cc: e.target.value })}
          />
        </div>
      )}

      {showBcc && (
        <div className="compose-field">
          <span className="compose-label">Bcc</span>
          <input
            className="compose-input"
            value={payload.bcc ?? ''}
            onChange={(e) => update({ bcc: e.target.value })}
          />
        </div>
      )}

      <div className="compose-field">
        <span className="compose-label">Subject</span>
        <input
          className="compose-input"
          value={payload.subject}
          onChange={(e) => update({ subject: e.target.value })}
        />
      </div>

      <div className="compose-editor-area">
        <RichTextEditor
          key={editorSeq}
          initialHtml={payload.bodyHtml}
          placeholder="Write your message…"
          onChange={(html, text) => {
            bodyHtmlRef.current = html
            bodyTextRef.current = text
          }}
        />

        {quoted && (
          <div className="compose-quote">
            <div className="compose-quote-divider">
              <button
                type="button"
                className={`compose-quote-toggle${quotedExpanded ? ' is-open' : ''}`}
                onClick={() => setQuotedExpanded((v) => !v)}
                title={quotedExpanded ? 'Hide quoted text' : 'Show quoted text'}
              >
                <CaretRight size={12} weight="bold" />
                {quotedExpanded ? 'Hide quoted text' : 'Show quoted text'}
              </button>
              <span className="compose-quote-line" />
            </div>
            {quotedExpanded && (
              <div
                className="compose-quote-body"
                dangerouslySetInnerHTML={{ __html: quoted.html }}
              />
            )}
          </div>
        )}
      </div>

      {attachments.length > 0 && (
        <div className="compose-attachments">
          {attachments.map((att) => {
            const Icon = attachmentIcon(att.name)
            return (
              <div key={att.path} className="compose-attachment-item">
                <Icon size={20} weight="duotone" className="compose-attachment-icon" />
                <div className="compose-attachment-meta">
                  <span className="compose-attachment-name" title={att.name}>
                    {att.name}
                  </span>
                  <span className="compose-attachment-size">{formatBytes(att.size)}</span>
                </div>
                <button
                  type="button"
                  className="compose-attachment-remove"
                  onClick={() => handleRemoveAttachment(att.path)}
                  aria-label={`Remove ${att.name}`}
                >
                  <X size={13} weight="bold" />
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="compose-actions">
        <button
          type="button"
          className="btn btn-secondary compose-attach-btn"
          onClick={handlePickAttachments}
          disabled={sending}
        >
          <Paperclip size={15} weight="bold" />
          Attach
        </button>
        <span className="compose-actions-spacer" />
        <span className="compose-send-hint">⌘↵ to send</span>
        <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>

      {dragging && (
        <div className="compose-drop-overlay">
          <Paperclip size={28} weight="duotone" />
          <span>Drop files to attach</span>
        </div>
      )}
    </div>
  )
}
