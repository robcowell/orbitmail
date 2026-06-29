import { useState, useEffect } from 'react'
import type { ComposePayload } from '../../../shared/types'
import { useMailStore } from '../../stores/mailStore'
import { loadInitialData } from '../../stores/mailStore'
import { Paperclip, X } from '../icons'

const emptyPayload = (accountId: string): ComposePayload => ({
  accountId,
  to: '',
  cc: '',
  bcc: '',
  subject: '',
  bodyHtml: '',
  bodyText: ''
})

export function ComposeWindow() {
  const accounts = useMailStore((s) => s.accounts)
  const setToast = useMailStore((s) => s.setToast)
  const [payload, setPayload] = useState<ComposePayload | null>(null)
  const [sending, setSending] = useState(false)
  const [showCc, setShowCc] = useState(false)
  const [showBcc, setShowBcc] = useState(false)
  const [attachmentPaths, setAttachmentPaths] = useState<string[]>([])

  useEffect(() => {
    void loadInitialData()
  }, [])

  useEffect(() => {
    const unsub = window.orbitMail.compose.onOpen((initial) => {
      const accountId = initial.accountId ?? accounts[0]?.id ?? ''
      setPayload({
        ...emptyPayload(accountId),
        ...initial
      })
      setAttachmentPaths(initial.attachmentPaths ?? [])
      if (initial.cc) setShowCc(true)
      if (initial.bcc) setShowBcc(true)
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

  const handlePickAttachments = async () => {
    const paths = await window.orbitMail.compose.pickAttachments()
    if (paths.length === 0) return
    setAttachmentPaths((current) => [...current, ...paths])
  }

  const handleRemoveAttachment = (path: string) => {
    setAttachmentPaths((current) => current.filter((p) => p !== path))
  }

  const handleSend = async () => {
    if (!payload.to.trim()) {
      setToast('Please enter a recipient')
      return
    }
    setSending(true)
    try {
      await window.orbitMail.compose.send({
        ...payload,
        attachmentPaths: attachmentPaths.length ? attachmentPaths : undefined
      })
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to send')
      setSending(false)
    }
  }

  const displayAccounts =
    accounts.length > 0
      ? accounts
      : payload.accountId
        ? [{ id: payload.accountId, email: payload.accountId, displayName: payload.accountId, provider: 'imap' as const }]
        : []

  return (
    <div className="compose-form">
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
          className="toolbar-btn"
          style={{ width: 'auto', padding: '0 6px', fontSize: 12 }}
          onClick={() => setShowCc(!showCc)}
        >
          Cc
        </button>
        <button
          className="toolbar-btn"
          style={{ width: 'auto', padding: '0 6px', fontSize: 12 }}
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

      <textarea
        className="compose-body"
        value={payload.bodyText}
        onChange={(e) =>
          update({ bodyText: e.target.value, bodyHtml: `<p>${e.target.value}</p>` })
        }
        placeholder="Write your message…"
      />

      {attachmentPaths.length > 0 && (
        <div className="compose-attachments">
          {attachmentPaths.map((path) => (
            <div key={path} className="compose-attachment-chip">
              <Paperclip size={14} weight="duotone" />
              <span>{path.split('/').pop()}</span>
              <button
                type="button"
                className="compose-attachment-remove"
                onClick={() => handleRemoveAttachment(path)}
                aria-label="Remove attachment"
              >
                <X size={12} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="compose-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handlePickAttachments}
          disabled={sending}
        >
          Attach
        </button>
        <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
