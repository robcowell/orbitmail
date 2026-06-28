import { useState, useEffect } from 'react'
import type { ComposePayload } from '../../../shared/types'
import { useMailStore } from '../../stores/mailStore'

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

  useEffect(() => {
    const unsub = window.orbitMail.compose.onOpen((initial) => {
      const accountId = initial.accountId ?? accounts[0]?.id ?? ''
      setPayload({
        ...emptyPayload(accountId),
        ...initial
      })
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

  const handleSend = async () => {
    if (!payload.to.trim()) {
      setToast('Please enter a recipient')
      return
    }
    setSending(true)
    try {
      await window.orbitMail.compose.send(payload)
      setToast('Message sent')
      setPayload(emptyPayload(payload.accountId))
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to send')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="compose-form">
      <div className="compose-field">
        <span className="compose-label">From</span>
        <select
          className="compose-input"
          value={payload.accountId}
          onChange={(e) => update({ accountId: e.target.value })}
        >
          {accounts.map((a) => (
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

      <div className="compose-actions">
        <button className="btn btn-primary" onClick={handleSend} disabled={sending}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}
