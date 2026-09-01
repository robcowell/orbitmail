import { useEffect, useState } from 'react'
import {
  AI_DETAILS,
  AI_EFFORTS,
  AI_MODELS,
  resolveAiDetail,
  resolveAiEffort,
  resolveAiModel,
  type AiDetail,
  type AiEffort
} from '../../../shared/ai-models'
import { useMailStore, setGlobalPreference } from '../../stores/mailStore'
import { SettingToggle } from './SettingToggle'
import { ipcErrorMessage } from '../../utils/ipcError'

// The body of what used to be AiSettingsDialog, minus its overlay and Close
// button — the settings shell owns both now.
export function AiPane() {
  const setToast = useMailStore((s) => s.setToast)
  const aiModel = useMailStore((s) => s.aiModel)
  const aiEffort = useMailStore((s) => s.aiEffort)
  const aiDetail = useMailStore((s) => s.aiDetail)
  const alwaysIncludeAttachments = useMailStore((s) => s.alwaysIncludeAttachments)
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
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Failed to save API key'))
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
      setToast(ipcErrorMessage(err, 'Failed to remove API key'))
    } finally {
      setSaving(false)
    }
  }

  const modelHint = AI_MODELS.find((m) => m.id === resolveAiModel(aiModel))?.hint
  const effortHint = AI_EFFORTS.find((e) => e.value === resolveAiEffort(aiEffort))?.hint
  const detailHint = AI_DETAILS.find((d) => d.value === resolveAiDetail(aiDetail))?.hint

  return (
    <>
    <section className="settings-section">
      <h3>Anthropic API key</h3>
      <p className="account-hint">
        Orbit Mail uses Anthropic&apos;s Claude to analyze the email you&apos;re reading, draft
        replies and sweep a folder for tasks. Your key is stored encrypted on this device and
        never leaves it except to call the Anthropic API.
      </p>

      <div className="account-info-row">
        <dt>Status</dt>
        <dd>{configured === null ? 'Checking…' : configured ? 'API key configured' : 'No API key'}</dd>
      </div>

      <label className="account-field">
        <span>API key</span>
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

      <div className="settings-section-actions">
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
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !key.trim()}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save key'}
        </button>
      </div>
    </section>

    <section className="settings-section">
      <h3>Model</h3>
      <p className="account-hint">
        Which Claude model the AI features call, how long it may think before answering, and
        how much the summaries say. All three affect what you are billed by Anthropic — a more
        capable model and a higher effort cost more per message, and a fuller summary is more
        of the output you pay for.
      </p>

      <label className="account-field">
        <span>Model</span>
        <select
          value={resolveAiModel(aiModel)}
          onChange={(event) => void setGlobalPreference('aiModel', event.target.value)}
        >
          {AI_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </label>
      {modelHint && <p className="account-hint">{modelHint}</p>}

      <label className="account-field">
        <span>Effort</span>
        <select
          value={resolveAiEffort(aiEffort)}
          onChange={(event) =>
            void setGlobalPreference('aiEffort', event.target.value as AiEffort)
          }
        >
          {AI_EFFORTS.map((effort) => (
            <option key={effort.value} value={effort.value}>
              {effort.label}
            </option>
          ))}
        </select>
      </label>
      {effortHint && <p className="account-hint">{effortHint}</p>}

      <label className="account-field">
        <span>Detail</span>
        <select
          value={resolveAiDetail(aiDetail)}
          onChange={(event) =>
            void setGlobalPreference('aiDetail', event.target.value as AiDetail)
          }
        >
          {AI_DETAILS.map((detail) => (
            <option key={detail.value} value={detail.value}>
              {detail.label}
            </option>
          ))}
        </select>
      </label>
      {detailHint && <p className="account-hint">{detailHint}</p>}

      <SettingToggle
        label="Always include attachments"
        description="Analyze reads Word, PDF, OpenDocument and other readable attachments without asking first. They cost extra tokens, which is why it asks by default."
        checked={alwaysIncludeAttachments}
        onChange={(next) => void setGlobalPreference('alwaysIncludeAttachments', next)}
      />

      <p className="account-hint">
        A change applies to the next analysis, draft or sweep. Results already saved are kept —
        the Tasks dialog has a <strong>Re-analyze all</strong> button for re-running a folder
        under the new setting.
      </p>
    </section>
    </>
  )
}
