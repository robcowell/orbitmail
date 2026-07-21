import { useCallback, useEffect, useState } from 'react'
import type {
  AutodetectResult,
  ConnectionSecurity,
  ManualAccountInput,
  OAuthConfigStatus,
  OAuthCredentialKey,
  ServerConfig
} from '../../../shared/types'
import { useMailStore, addAccount, addManualAccount } from '../../stores/mailStore'
import { AppBrand } from '../brand/AppBrand'

type WizardView = 'choose' | 'manual' | 'oauth-credentials'

const DEFAULT_INCOMING: ServerConfig = {
  host: '',
  port: 993,
  security: 'ssl'
}

const DEFAULT_OUTGOING: ServerConfig = {
  host: '',
  port: 587,
  security: 'starttls'
}

const EMPTY_FORM: ManualAccountInput = {
  email: '',
  displayName: '',
  username: '',
  password: '',
  incomingProtocol: 'imap',
  incoming: { ...DEFAULT_INCOMING },
  outgoing: { ...DEFAULT_OUTGOING }
}

function applyAutodetect(
  current: ManualAccountInput,
  result: AutodetectResult
): ManualAccountInput {
  if (!result.settings) return current
  return {
    ...current,
    email: result.settings.email ?? current.email,
    username: result.settings.username ?? current.username,
    incomingProtocol: result.settings.incomingProtocol ?? current.incomingProtocol,
    incoming: { ...current.incoming, ...result.settings.incoming },
    outgoing: { ...current.outgoing, ...result.settings.outgoing }
  }
}

function ServerFields({
  label,
  value,
  onChange
}: {
  label: string
  value: ServerConfig
  onChange: (next: ServerConfig) => void
}) {
  return (
    <fieldset className="account-fieldset">
      <legend>{label}</legend>
      <label className="account-field">
        <span>Server</span>
        <input
          value={value.host}
          onChange={(e) => onChange({ ...value, host: e.target.value })}
          placeholder="mail.example.com"
        />
      </label>
      <div className="account-field-row">
        <label className="account-field">
          <span>Port</span>
          <input
            type="number"
            value={value.port}
            onChange={(e) => onChange({ ...value, port: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="account-field">
          <span>Security</span>
          <select
            value={value.security}
            onChange={(e) =>
              onChange({ ...value, security: e.target.value as ConnectionSecurity })
            }
          >
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </label>
      </div>
    </fieldset>
  )
}

function ManualAccountForm({ onBack }: { onBack: () => void }) {
  const [form, setForm] = useState<ManualAccountInput>(EMPTY_FORM)
  const [autodetectMessage, setAutodetectMessage] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [detecting, setDetecting] = useState(false)

  const update = (patch: Partial<ManualAccountInput>) => {
    setForm((current) => ({ ...current, ...patch }))
  }

  const runAutodetect = async () => {
    setDetecting(true)
    setAutodetectMessage(null)
    try {
      const result = await window.orbitMail.accounts.autodetect(form.email)
      setForm((current) => applyAutodetect(current, result))
      setAutodetectMessage(result.message)
    } catch (err) {
      setAutodetectMessage(err instanceof Error ? err.message : 'Autodetect failed')
    } finally {
      setDetecting(false)
    }
  }

  const onSubmit = async () => {
    setSubmitting(true)
    try {
      await addManualAccount(form)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit =
    form.email.trim() &&
    form.username.trim() &&
    form.password &&
    form.incoming.host.trim() &&
    form.outgoing.host.trim()

  return (
    <>
      <p>
        Connect with your email address, username, and password. Use autodetect when
        possible, or enter incoming (IMAP/POP3) and outgoing (SMTP) server settings
        manually.
      </p>

      <label className="account-field">
        <span>Email address</span>
        <input
          type="email"
          value={form.email}
          onChange={(e) => {
            const email = e.target.value
            update({
              email,
              username: form.username === form.email ? email : form.username
            })
          }}
          placeholder="you@example.com"
        />
      </label>

      <label className="account-field">
        <span>Display name</span>
        <input
          value={form.displayName}
          onChange={(e) => update({ displayName: e.target.value })}
          placeholder="Optional"
        />
      </label>

      <label className="account-field">
        <span>Username</span>
        <input
          value={form.username}
          onChange={(e) => update({ username: e.target.value })}
          placeholder="Often your full email address"
        />
      </label>

      <label className="account-field">
        <span>Password</span>
        <input
          type="password"
          value={form.password}
          onChange={(e) => update({ password: e.target.value })}
          autoComplete="current-password"
        />
      </label>

      <div className="account-field-row">
        <label className="account-field">
          <span>Incoming protocol</span>
          <select
            value={form.incomingProtocol}
            onChange={(e) =>
              update({
                incomingProtocol: e.target.value as 'imap' | 'pop3',
                incoming: {
                  ...form.incoming,
                  port: e.target.value === 'pop3' ? 995 : 993,
                  security: 'ssl'
                }
              })
            }
          >
            <option value="imap">IMAP</option>
            <option value="pop3">POP3</option>
          </select>
        </label>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={runAutodetect}
          disabled={!form.email.trim() || detecting}
        >
          {detecting ? 'Detecting…' : 'Autodetect'}
        </button>
      </div>

      {autodetectMessage && <p className="account-hint">{autodetectMessage}</p>}

      <ServerFields
        label="Incoming mail server"
        value={form.incoming}
        onChange={(incoming) => update({ incoming })}
      />

      <ServerFields
        label="Outgoing mail server (SMTP)"
        value={form.outgoing}
        onChange={(outgoing) => update({ outgoing })}
      />

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSubmit}
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Connecting…' : 'Add Account'}
        </button>
      </div>
    </>
  )
}


// Asks for the OAuth app credentials for one provider. Shown when the provider
// is picked but nothing has supplied its credentials yet — the alternative
// being an error telling the user to go and edit a file.
//
// Fields start empty and are never pre-filled: stored values are not readable
// by the renderer by design. A key already supplied by the environment is shown
// as such and disabled, because writing it here would have no effect.
function OAuthCredentialsForm({
  provider,
  status,
  onSaved,
  onBack
}: {
  provider: 'gmail' | 'o365'
  status: OAuthConfigStatus
  onSaved: () => void
  onBack: () => void
}) {
  const isGoogle = provider === 'gmail'
  const [values, setValues] = useState<Partial<Record<OAuthCredentialKey, string>>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fields: { key: OAuthCredentialKey; label: string; hint?: string; secret?: boolean }[] =
    isGoogle
      ? [
          { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', hint: 'Ends in .apps.googleusercontent.com' },
          { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true }
        ]
      : [
          { key: 'MICROSOFT_CLIENT_ID', label: 'Application (client) ID' },
          {
            key: 'MICROSOFT_TENANT_ID',
            label: 'Directory (tenant) ID',
            hint: 'Optional — defaults to "common" for personal and work accounts'
          }
        ]

  const required = fields.filter((f) => f.key !== 'MICROSOFT_TENANT_ID')
  const satisfied = (key: OAuthCredentialKey) =>
    status.fromEnvironment.includes(key) || !!values[key]?.trim()
  const canSave = required.every((f) => satisfied(f.key))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      // Only send what was typed; untouched fields must not clear stored values.
      const entered = Object.fromEntries(
        Object.entries(values).filter(([, v]) => (v ?? '').trim().length > 0)
      )
      await window.orbitMail.oauth.saveCredentials(entered)
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save credentials')
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <p>
        {isGoogle ? 'Gmail' : 'Microsoft 365'} sign-in uses an OAuth app that you register
        once. Orbit Mail ships without credentials, so builds are safe to share — paste
        yours below and they are stored encrypted on this machine.
      </p>
      <p className="account-hint">
        See DEVELOPERS.md → OAuth setup for the registration steps. You can also set them
        in <code>~/.config/orbit-mail/.env</code> instead.
      </p>

      {!status.encryptionAvailable && (
        <p className="account-hint">
          No system keyring is available, so these will be stored obfuscated rather than
          encrypted. Consider using <code>~/.config/orbit-mail/.env</code> instead.
        </p>
      )}

      {fields.map((field) => {
        const fromEnv = status.fromEnvironment.includes(field.key)
        return (
          <label className="account-field" key={field.key}>
            <span>{field.label}</span>
            <input
              type={field.secret ? 'password' : 'text'}
              value={fromEnv ? '' : values[field.key] ?? ''}
              disabled={fromEnv}
              placeholder={fromEnv ? 'Set by the environment' : ''}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setValues((v) => ({ ...v, [field.key]: e.target.value }))}
            />
            {field.hint && !fromEnv && <span className="account-hint">{field.hint}</span>}
          </label>
        )
      })}

      {error && <p className="account-hint">{error}</p>}

      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={!canSave || saving}
        >
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </div>
    </>
  )
}

export function AddAccountWizard() {
  const show = useMailStore((s) => s.showAddAccount)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const accounts = useMailStore((s) => s.accounts)
  const [view, setView] = useState<WizardView>('choose')
  const [oauthProvider, setOauthProvider] = useState<'gmail' | 'o365'>('gmail')
  const [oauthStatus, setOauthStatus] = useState<OAuthConfigStatus | null>(null)

  // With no accounts there is nothing to go back to, which is why the Cancel
  // button is hidden in that case — so Escape must not dismiss it either.
  const cancellable = accounts.length > 0

  const close = useCallback(() => {
    setView('choose')
    setShowAddAccount(false)
  }, [setShowAddAccount])

  // Escape does what Cancel does. Declared before the early return below so the
  // hook order stays stable.
  useEffect(() => {
    if (!show || !cancellable) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [show, cancellable, close])

  // Ask for credentials only when the provider cannot start a sign-in without
  // them. Anyone with a .env or environment variables set never sees this.
  const startOAuth = async (provider: 'gmail' | 'o365') => {
    let status: OAuthConfigStatus | null = null
    try {
      status = await window.orbitMail.oauth.getStatus()
    } catch {
      // Status is an optimisation; if it fails, let the sign-in report the problem.
    }
    const configured = provider === 'gmail' ? status?.google : status?.microsoft
    if (status && !configured) {
      setOauthProvider(provider)
      setOauthStatus(status)
      setView('oauth-credentials')
      return
    }
    void addAccount(provider)
  }

  if (!show) return null

  return (
    // Deliberately modal: no overlay click handler, so clicking the app behind
    // the dialog leaves it in place. Adding an account is a multi-step flow that
    // opens a browser for OAuth, and dismissing it with a stray click — losing
    // half-typed IMAP settings — was too easy.
    <div className="modal-overlay">
      <div className="modal modal-wide">
        <AppBrand />
        <h2 style={{ marginTop: 16 }}>Add Email Account</h2>

        {view === 'choose' ? (
          <>
            <p>
              Connect Gmail or Microsoft 365 with OAuth, or add any provider using
              standard IMAP/POP3 and SMTP with your username and password.
            </p>
            <div className="modal-actions modal-actions-stack">
              <button className="btn btn-secondary" onClick={() => void startOAuth('gmail')}>
                Gmail (OAuth)
              </button>
              {/* All three are equal choices — none is a primary action, so none
                  gets the brand gradient. Microsoft 365 used to, which read as a
                  recommendation the app has no basis for making. */}
              <button className="btn btn-secondary" onClick={() => void startOAuth('o365')}>
                Microsoft 365 (OAuth)
              </button>
              <button className="btn btn-secondary" onClick={() => setView('manual')}>
                Other (IMAP / POP3)
              </button>
            </div>
            {accounts.length > 0 && (
              <button
                className="btn btn-secondary"
                style={{ marginTop: 12, width: '100%' }}
                onClick={close}
              >
                Cancel
              </button>
            )}
          </>
        ) : view === 'oauth-credentials' && oauthStatus ? (
          <OAuthCredentialsForm
            provider={oauthProvider}
            status={oauthStatus}
            onBack={() => setView('choose')}
            onSaved={() => {
              setView('choose')
              void addAccount(oauthProvider)
            }}
          />
        ) : (
          <ManualAccountForm onBack={() => setView('choose')} />
        )}
      </div>
    </div>
  )
}
