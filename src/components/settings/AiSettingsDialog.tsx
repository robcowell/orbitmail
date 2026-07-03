import { useEffect, useState } from 'react'
import { useMailStore } from '../../stores/mailStore'

interface AiSettingsDialogProps {
  onClose: () => void
}

export function AiSettingsDialog({ onClose }: AiSettingsDialogProps) {
  const setToast = useMailStore((s) => s.setToast)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.orbitMail.ai
      .getStatus()
      .then((status) => {
        if (!cancelled) setConfigured(status.configured)
      })
      .catch(() => {
        if (!cancelled) setConfigured(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    if (!key.trim()) return
    setSaving(true)
    try {
      await window.orbitMail.ai.setApiKey(key.trim())
      setKey('')
      setConfigured(true)
      setToast('Anthropic API key saved')
      onClose()
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to save API key')
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await window.orbitMail.ai.clearApiKey()
      setConfigured(false)
      setToast('Anthropic API key removed')
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'Failed to remove API key')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>AI Settings</h2>
        <p className="account-hint">
          Orbit Mail uses Anthropic&apos;s Claude to analyze the email you&apos;re reading. Paste an
          Anthropic API key to enable the Analyze button. Your key is stored encrypted on this
          device and never leaves it except to call the Anthropic API.
        </p>

        <div className="account-info-row">
          <dt>Status</dt>
          <dd>
            {configured === null
              ? 'Checking…'
              : configured
                ? 'API key configured'
                : 'No API key'}
          </dd>
        </div>

        <label className="account-field">
          <span>Anthropic API key</span>
          <input
            type="password"
            autoComplete="off"
            placeholder="sk-ant-…"
            value={key}
            disabled={saving}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handleSave()
            }}
          />
        </label>

        <div className="modal-actions">
          {configured && (
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={() => void handleClear()}
            >
              Remove key
            </button>
          )}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !key.trim()}
            onClick={() => void handleSave()}
          >
            {saving ? 'Saving…' : 'Save key'}
          </button>
        </div>
      </div>
    </div>
  )
}
