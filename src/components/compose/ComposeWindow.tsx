import { useState, useEffect, useRef } from 'react'
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml'
import { snoozePresets, formatWakeAt } from '../../utils/snoozePresets'
import { assumesLightBackground } from '../../utils/emailColorScheme'
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
import { RecipientInput } from './RecipientInput'
import { formatBytes } from '../../utils/format'
import { joinBodyWithQuote } from '../../utils/composeBody'
import { SIGNATURE_CLASS, signatureAppendix } from '../../../shared/signature'
import { ipcErrorMessage } from '../../utils/ipcError'

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
  const [sendLaterOpen, setSendLaterOpen] = useState(false)
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([])
  const [quoted, setQuoted] = useState<{ html: string; text: string } | null>(null)
  // Whether the quoted original needs a light surface to be readable in dark
  // mode — the same problem the reader has, since this is the same sender HTML.
  // Decided once, when the quote arrives, rather than from the live edited
  // value: it is a fact about the mail being replied to, and recomputing it per
  // keystroke would also let the block flip colour mid-edit as the user trims
  // the coloured part away.
  const [quotedPaper, setQuotedPaper] = useState(false)
  const [quotedExpanded, setQuotedExpanded] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [editorSeq, setEditorSeq] = useState(0)

  // Editor content lives in the DOM (uncontrolled); mirror it into refs so we can
  // read the latest value at send time without re-rendering on every keystroke.
  const bodyHtmlRef = useRef('')
  const bodyTextRef = useRef('')

  // Autosave. The draft id is a ref rather than state: the first save assigns
  // one, and every save after it must reuse that id or each keystroke burst
  // would create a new draft. Nothing renders from it, so it must not re-render.
  const draftIdRef = useRef<string | null>(null)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sendingRef = useRef(false)

  // Mirrors of the state the save reads. A debounced save fires outside React's
  // render, so closing over state would persist whatever it was when the timer
  // was armed rather than what is on screen now.
  const payloadRef = useRef<ComposePayload | null>(null)
  const quotedRef = useRef<{ html: string; text: string } | null>(null)
  // The editable quote's DOM node. It is uncontrolled like the body editor, so
  // its current content is read out of the DOM rather than mirrored in state.
  const quoteElementRef = useRef<HTMLDivElement | null>(null)
  // The body editor's own node, needed to swap the signature block in place when
  // the From account changes — see swapSignature.
  const editorElementRef = useRef<HTMLDivElement | null>(null)
  const attachmentsRef = useRef<AttachmentDraft[]>([])
  payloadRef.current = payload
  quotedRef.current = quoted
  attachmentsRef.current = attachments

  useEffect(() => {
    void loadInitialData()
  }, [])

  /**
   * The quote as it stands right now.
   *
   * Prefers the live DOM over React state: `onInput` has fired for the last
   * keystroke but its re-render may not have flushed by the time Send is
   * clicked, so reading state here can be one edit behind. When the quote is
   * collapsed the element is unmounted and state holds the last edit.
   */
  const currentQuote = (): { html: string; text: string } | null => {
    const el = quoteElementRef.current
    if (el) return { html: el.innerHTML, text: el.innerText }
    return quotedRef.current
  }

  // Everything needed to save, read at the moment of saving — the body lives in
  // refs, so a snapshot taken earlier would persist a stale one.
  const currentDraft = (): Partial<ComposePayload> | null => {
    if (!payloadRef.current) return null
    const p = payloadRef.current
    return {
      accountId: p.accountId,
      to: p.to,
      cc: p.cc,
      bcc: p.bcc,
      subject: p.subject,
      bodyHtml: bodyHtmlRef.current,
      bodyText: bodyTextRef.current,
      quotedHtml: currentQuote()?.html,
      quotedText: currentQuote()?.text,
      inReplyTo: p.inReplyTo,
      references: p.references,
      mode: p.mode,
      originalMessageId: p.originalMessageId,
      attachmentPaths: attachmentsRef.current.map((a) => a.path)
    }
  }

  const saveDraftNow = async (): Promise<void> => {
    // A send in flight owns this content now; saving here would either race the
    // delete that follows a successful send or resurrect what was just sent.
    if (sendingRef.current) return
    const draft = currentDraft()
    if (!draft) return
    try {
      draftIdRef.current = await window.orbitMail.drafts.save(draft, draftIdRef.current ?? undefined)
    } catch {
      // Autosave is best-effort — the composer keeps its content either way, and
      // a toast on every failed keystroke burst would be worse than silence.
    }
  }

  const scheduleDraftSave = (): void => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => void saveDraftNow(), 800)
  }

  // Closing the window must not lose what the debounce has not written yet.
  // `beforeunload` is the only hook that fires for an OS window close, and it
  // cannot await — so the save is *requested* here and the main process holds
  // the window open for it (see compose:flushDraft).
  useEffect(() => {
    const flush = () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      void saveDraftNow()
    }
    window.addEventListener('beforeunload', flush)
    window.__orbitMailFlushDraft = async () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      await saveDraftNow()
      // Returned so main can tell the user *where* the draft went. Closing keeps
      // it silently otherwise, which means hunting for it in the wrong account's
      // Drafts folder.
      return draftIdRef.current
    }
    return () => window.removeEventListener('beforeunload', flush)
  })

  // Fill the editable quote when it is expanded. Written straight to the DOM,
  // once: letting React own the innerHTML would reset the caret on every
  // keystroke, which is the same reason the body editor is uncontrolled.
  useEffect(() => {
    if (!quotedExpanded) return
    const el = quoteElementRef.current
    if (el) el.innerHTML = quotedRef.current?.html ?? ''
  }, [quotedExpanded])

  useEffect(() => {
    const unsub = window.orbitMail.compose.onOpen((initial) => {
      const accountId = initial.accountId ?? accounts[0]?.id ?? ''
      // The window is reused, so a new payload replaces whatever was being
      // edited. Flush that first or the previous draft loses its last edits.
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        void saveDraftNow()
      }
      draftIdRef.current = initial.draftId ?? null
      setPayload({ ...emptyPayload(accountId), ...initial })
      bodyHtmlRef.current = initial.bodyHtml ?? ''
      bodyTextRef.current = initial.bodyText ?? ''
      setEditorSeq((n) => n + 1)
      // Sanitize the quoted original once, here, so both the preview and the
      // sent body use the safe version. The raw HTML is the sender's — sending
      // it verbatim would carry their scripts/navigation sinks and, worse, their
      // remote trackers into our reply and the Sent copy. blockRemoteContent
      // strips remote images/backgrounds, matching how the reader renders them.
      const quotedHtml =
        sanitizeEmailHtml(initial.quotedHtml ?? '', { blockRemoteContent: true }) ?? ''
      setQuoted(
        initial.quotedHtml || initial.quotedText
          ? { html: quotedHtml, text: initial.quotedText ?? '' }
          : null
      )
      setQuotedPaper(assumesLightBackground(quotedHtml))
      setQuotedExpanded(false)
      if (initial.cc) setShowCc(true)
      if (initial.bcc) setShowBcc(true)
      const paths = initial.attachmentPaths ?? []
      if (paths.length) {
        void window.orbitMail.compose.statAttachments(paths).then(setAttachments)
      } else {
        setAttachments([])
      }
      // Main opened the composer with something missing — most often a forward
      // whose attachment could not be downloaded.
      if (initial.notice) setToast(initial.notice)
    })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts])

  if (!payload) {
    return (
      <div className="reader-empty" style={{ height: '100%' }}>
        New Message
      </div>
    )
  }

  const update = (patch: Partial<ComposePayload>) => {
    setPayload((p) => (p ? { ...p, ...patch } : p))
    scheduleDraftSave()
  }

  /**
   * Take the blank line before the signature with the signature.
   *
   * The separator is deliberately outside the block (see shared/signature.ts), so
   * removing the block on its own leaves the `<br><br>` behind — and appending a
   * signature again adds another pair. Switching From back and forth then grows a
   * stack of blank lines above the signature.
   */
  const dropSeparatorBefore = (node: Element): void => {
    let removedBreaks = 0
    let prev = node.previousSibling
    while (prev && removedBreaks < 2) {
      const isBreak = prev.nodeName === 'BR'
      const isBlankText = prev.nodeType === Node.TEXT_NODE && !prev.textContent?.trim()
      if (!isBreak && !isBlankText) break
      const doomed = prev
      prev = prev.previousSibling
      if (isBreak) removedBreaks++
      ;(doomed as ChildNode).remove()
    }
  }

  /**
   * Replace the signature block with the newly chosen account's, in place.
   *
   * Done to the DOM rather than through state because the body editor is
   * uncontrolled: re-rendering it means remounting it (the `editorSeq` key),
   * which would throw away everything typed so far. So this edits around the
   * user, leaving their text and the caret alone.
   *
   * The three cases, all of them reachable:
   * - a block is there and the new account has a signature → swap its contents
   * - a block is there and the new account has none → remove it
   * - no block (an account with no signature composed this, or the user deleted
   *   it) and the new account has one → append one
   *
   * A signature the user has *edited* is still replaced, which is what swapping
   * means and what other clients do — the block is marked as the signature, not
   * as prose. Sanitized on the way in even though it was sanitized when saved:
   * this is an innerHTML sink in a window carrying the full preload, and the
   * stored value came from a different process.
   */
  const swapSignature = async (accountId: string): Promise<void> => {
    const el = editorElementRef.current
    if (!el) return

    let signature = ''
    try {
      signature = await window.orbitMail.accounts.getSignature(accountId)
    } catch {
      // A signature that cannot be read is not worth failing a compose over; the
      // previous one stays, which is the pre-existing behaviour.
      return
    }

    const existing = el.querySelector(`.${SIGNATURE_CLASS}`)
    const clean = signature.trim() ? sanitizeEmailHtml(signature) ?? '' : ''

    if (existing && clean) {
      existing.innerHTML = clean
    } else if (existing) {
      dropSeparatorBefore(existing)
      existing.remove()
    } else if (clean) {
      el.insertAdjacentHTML('beforeend', signatureAppendix(clean))
    } else {
      return
    }

    // The editor only reports changes the user makes, so mirror the new content
    // into the refs the send and the autosave read.
    bodyHtmlRef.current = el.innerHTML
    bodyTextRef.current = el.innerText
    scheduleDraftSave()
  }

  const addDrafts = (drafts: AttachmentDraft[]) => {
    if (drafts.length === 0) return
    scheduleDraftSave()
    setAttachments((current) => {
      const seen = new Set(current.map((a) => a.path))
      return [...current, ...drafts.filter((d) => !seen.has(d.path))]
    })
  }

  const handlePickAttachments = async () => {
    addDrafts(await window.orbitMail.compose.pickAttachments())
  }

  /**
   * Read the edited quote back out of the DOM.
   *
   * The plain-text half is regenerated from `innerText` rather than kept as the
   * original `quotedText`: once the HTML has been trimmed, the stored text
   * version describes a quote that is no longer being sent, and the recipient's
   * plain-text part would disagree with the HTML one.
   */
  const readQuoteFromDom = () => {
    const el = quoteElementRef.current
    if (!el) return
    setQuoted({ html: el.innerHTML, text: el.innerText })
    scheduleDraftSave()
  }

  const handleRemoveQuote = () => {
    setQuoted(null)
    setQuotedExpanded(false)
    scheduleDraftSave()
  }

  const handleRemoveAttachment = (path: string) => {
    setAttachments((current) => current.filter((a) => a.path !== path))
    scheduleDraftSave()
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

  const handleSend = async (sendAt?: number) => {
    if (!payload.to.trim()) {
      setToast('Please enter a recipient')
      return
    }
    if (sending) return
    sendingRef.current = true
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const { bodyHtml, bodyText } = joinBodyWithQuote(
      bodyHtmlRef.current,
      bodyTextRef.current,
      currentQuote()
    )
    setSending(true)
    try {
      await window.orbitMail.compose.scheduleSend({
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
        // Main holds this draft for the length of the undo window and deletes
        // it once the message is actually away, not before.
        draftId: draftIdRef.current ?? undefined,
        attachmentPaths: attachments.length ? attachments.map((a) => a.path) : undefined
      }, sendAt)
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Failed to send'))
      // The send failed, so this is a draft again — and the content is now only
      // in this window until the next save.
      sendingRef.current = false
      setSending(false)
      void saveDraftNow()
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
          onChange={(e) => {
            update({ accountId: e.target.value })
            void swapSignature(e.target.value)
          }}
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
        <RecipientInput
          value={payload.to}
          accountId={payload.accountId}
          ariaLabel="To"
          placeholder="Recipient"
          onChange={(to) => update({ to })}
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
          <RecipientInput
            value={payload.cc ?? ''}
            accountId={payload.accountId}
            ariaLabel="Cc"
            onChange={(cc) => update({ cc })}
          />
        </div>
      )}

      {showBcc && (
        <div className="compose-field">
          <span className="compose-label">Bcc</span>
          <RecipientInput
            value={payload.bcc ?? ''}
            accountId={payload.accountId}
            ariaLabel="Bcc"
            onChange={(bcc) => update({ bcc })}
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
          onImageRejected={setToast}
          onElement={(el) => {
            editorElementRef.current = el
          }}
          onChange={(html, text) => {
            bodyHtmlRef.current = html
            bodyTextRef.current = text
            scheduleDraftSave()
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
              <button
                type="button"
                className="compose-quote-remove"
                onClick={handleRemoveQuote}
                title="Remove the quoted message from this reply"
              >
                Remove
              </button>
            </div>
            {quotedExpanded && (
              // Editable, so the quote can be trimmed to the part being replied
              // to rather than always going out whole. Uncontrolled and set once
              // via ref — writing innerHTML from React on every keystroke would
              // reset the caret, the same reason RichTextEditor is uncontrolled.
              //
              // The HTML was sanitized when the payload arrived, so this is not
              // re-cleaning attacker content on every keystroke; it is the same
              // string, now editable.
              // The paper class is on this element, not inside it, so it is not
              // part of `innerHTML` and cannot travel out with the reply.
              <div
                ref={quoteElementRef}
                className={`compose-quote-body is-editable${
                  quotedPaper ? ' email-html-paper' : ''
                }`}
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-label="Quoted message"
                suppressContentEditableWarning
                onInput={readQuoteFromDom}
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
        {/* A message timed for later stays in Drafts, which is where it can be
            seen and where opening it takes it back out of the queue. */}
        <div className="compose-send-later">
          <button
            type="button"
            className="btn"
            onClick={() => setSendLaterOpen((open) => !open)}
            disabled={sending}
            aria-expanded={sendLaterOpen}
            title="Send later"
          >
            Send later
          </button>
          {sendLaterOpen && (
            <div className="compose-send-later-menu">
              {/* The same "when later means" arithmetic snooze uses: whole
                  hours, never in the past, and no option that would fire
                  immediately. */}
              {snoozePresets(Date.now())
                .filter((preset) => preset.wakeAt !== null)
                .map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="compose-send-later-item"
                    onClick={() => {
                      setSendLaterOpen(false)
                      void handleSend(preset.wakeAt as number)
                    }}
                  >
                    <span>{preset.label}</span>
                    <span className="compose-send-later-when">
                      {formatWakeAt(preset.wakeAt as number)}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </div>
        <button className="btn btn-primary" onClick={() => void handleSend()} disabled={sending}>
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

declare global {
  interface Window {
    /**
     * Returns the save's promise so main can await it before letting the
     * compose window close, rather than closing on a request that may not have
     * landed. Mirrors __orbitMailFlush for UI preferences.
     */
    __orbitMailFlushDraft?: () => Promise<string | null>
  }
}
