import { useEffect, useState } from 'react'
import type {
  Account,
  AccountInfo,
  ManualAccountSettings,
  ManualAccountSettingsUpdate
} from '../../../shared/types'
import {
  useMailStore,
  refreshMessages,
  removeAccountById,
  syncAccountById,
  updateAccountDisplayName,
  updateAccountSyncDays
} from '../../stores/mailStore'
import { ServerFields } from '../accounts/ServerFields'
import { RichTextEditor } from '../compose/RichTextEditor'
import { sanitizeEmailHtml } from '../../utils/sanitizeEmailHtml'
import { ipcErrorMessage } from '../../utils/ipcError'

const SYNC_WINDOW_OPTIONS = [
  { label: '30 days', value: 30 },
  { label: '90 days', value: 90 },
  { label: '180 days', value: 180 },
  { label: '1 year', value: 365 },
  { label: 'Unlimited', value: 0 }
] as const

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function accountLabel(account: Account): string {
  return account.displayName && account.displayName !== account.email
    ? account.displayName
    : account.email
}

/**
 * Which account the pane should be showing.
 *
 * Exported because the failure it prevents is not visible until it happens:
 * removing the selected account leaves `current` pointing at an id that no
 * longer exists, and the pane renders nothing at all. `aimedAt` wins when it is
 * still real — that is Settings being opened *for* an account — otherwise a
 * live selection is kept and anything else falls back to the first account.
 */
export function resolveSelectedAccountId(
  accounts: { id: string }[],
  aimedAt: string | null,
  current: string | null
): string | null {
  const exists = (id: string | null) => !!id && accounts.some((a) => a.id === id)
  if (exists(aimedAt)) return aimedAt
  if (exists(current)) return current
  return accounts[0]?.id ?? null
}

// The account's signature, edited with the same editor the composer uses — so
// what is typed here is what a message will carry, including a pasted logo.
//
// Sanitized on save: the main process has no DOM and cannot clean HTML, and this
// text is appended to the body of every message the account sends.
function SignatureSettings({
  account,
  info,
  onSaved
}: {
  account: Account
  info: AccountInfo | null
  onSaved: () => void
}) {
  const setToast = useMailStore((s) => s.setToast)
  const [html, setHtml] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  // The editor is uncontrolled, so it is remounted (via key) when the account
  // changes — otherwise switching accounts would leave the previous one's
  // signature in the box.
  const editorKey = `${account.id}:${info?.signature ?? ''}`

  const handleSave = async () => {
    setSaving(true)
    try {
      await window.orbitMail.accounts.updateSignature(
        account.id,
        sanitizeEmailHtml(html) ?? ''
      )
      setDirty(false)
      setToast('Signature saved')
      onSaved()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Could not save the signature'))
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await window.orbitMail.accounts.updateSignature(account.id, '')
      setHtml('')
      setDirty(false)
      setToast('Signature removed')
      onSaved()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Could not remove the signature'))
    } finally {
      setSaving(false)
    }
  }

  if (!info) return null

  return (
    <section className="settings-section">
      <h3>Signature</h3>
      <p className="account-hint">
        Added to the end of what you write on new messages, replies and forwards — above the
        quoted text. Paste an image to include a logo.
      </p>
      <div className="settings-signature-editor">
        <RichTextEditor
          key={editorKey}
          initialHtml={info.signature}
          placeholder="Your name, role, phone…"
          onImageRejected={setToast}
          onChange={(next) => {
            setHtml(next)
            setDirty(true)
          }}
        />
      </div>
      <div className="settings-section-actions">
        {info.signature && (
          <button
            type="button"
            className="btn btn-secondary"
            disabled={saving}
            onClick={() => void handleClear()}
          >
            Remove
          </button>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || !dirty}
          onClick={() => void handleSave()}
        >
          {saving ? 'Saving…' : 'Save signature'}
        </button>
      </div>
      <p className="account-hint">
        A signature is added when the composer opens, and changing the From account swaps it —
        including one you have edited, which is replaced along with the rest of the block.
      </p>
    </section>
  )
}

// Server settings for a manual (IMAP/POP3) account. Renders nothing for OAuth
// accounts, which have no servers to configure.
//
// The password box is always empty: main never sends the stored one, and leaving
// it blank means "keep it". `hasPassword` is the only thing the renderer learns
// about it.
function ConnectionSettings({ account }: { account: Account }) {
  const setToast = useMailStore((s) => s.setToast)
  const [settings, setSettings] = useState<ManualAccountSettings | null>(null)
  const [draft, setDraft] = useState<ManualAccountSettingsUpdate | null>(null)
  const [password, setPassword] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [saving, setSaving] = useState(false)

  const isManual = account.provider === 'imap' || account.provider === 'pop3'

  useEffect(() => {
    if (!isManual) {
      setSettings(null)
      setDraft(null)
      return
    }
    let cancelled = false
    setPassword('')
    setTestResult(null)
    void window.orbitMail.accounts
      .getManualSettings(account.id)
      .then((result) => {
        if (cancelled || !result) return
        setSettings(result)
        setDraft({
          displayName: result.displayName,
          username: result.username,
          incoming: result.incoming,
          outgoing: result.outgoing
        })
      })
      .catch(() => {
        if (!cancelled) setToast('Could not load this account’s server settings')
      })
    return () => {
      cancelled = true
    }
  }, [account.id, isManual, setToast])

  if (!isManual || !settings || !draft) return null

  const payload = (): ManualAccountSettingsUpdate => ({
    ...draft,
    password: password.trim() ? password : undefined
  })

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      setTestResult(await window.orbitMail.accounts.testManualSettings(account.id, payload()))
    } catch (err) {
      setTestResult({ ok: false, error: ipcErrorMessage(err, 'Could not connect') })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setTestResult(null)
    try {
      await window.orbitMail.accounts.updateManualSettings(account.id, payload())
      setPassword('')
      setToast('Server settings saved')
      const refreshed = await window.orbitMail.accounts.getManualSettings(account.id)
      if (refreshed) setSettings(refreshed)
    } catch (err) {
      // The save verifies the settings first, so this is usually the servers
      // rejecting them rather than a write failing.
      setTestResult({
        ok: false,
        error: ipcErrorMessage(err, 'Could not save these settings')
      })
    } finally {
      setSaving(false)
    }
  }

  const busy = testing || saving

  return (
    <section className="settings-section">
      <h3>Server settings</h3>

      <label className="account-field">
        <span>Email address</span>
        <input value={settings.email} readOnly disabled />
      </label>
      <p className="account-hint">
        The address and the protocol ({settings.incomingProtocol.toUpperCase()}) cannot be changed
        here — both identify the account. To move to a different address or protocol, remove this
        account and add it again.
      </p>

      <label className="account-field">
        <span>Username</span>
        <input
          value={draft.username}
          disabled={busy}
          onChange={(event) => setDraft({ ...draft, username: event.target.value })}
        />
      </label>

      <label className="account-field">
        <span>Password</span>
        <input
          type="password"
          autoComplete="off"
          placeholder={settings.hasPassword ? 'Leave blank to keep the saved password' : ''}
          value={password}
          disabled={busy}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>

      <ServerFields
        label={settings.incomingProtocol === 'pop3' ? 'Incoming (POP3)' : 'Incoming (IMAP)'}
        value={draft.incoming}
        onChange={(incoming) => setDraft({ ...draft, incoming })}
      />
      <ServerFields
        label="Outgoing (SMTP)"
        value={draft.outgoing}
        onChange={(outgoing) => setDraft({ ...draft, outgoing })}
      />

      {testResult && (
        <p className={`account-hint${testResult.ok ? '' : ' is-error'}`}>
          {testResult.ok ? 'Connected successfully.' : testResult.error}
        </p>
      )}

      <div className="settings-section-actions">
        <button
          type="button"
          className="btn btn-secondary"
          disabled={busy}
          onClick={() => void handleTest()}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void handleSave()}
        >
          {saving ? 'Checking and saving…' : 'Save'}
        </button>
      </div>
      <p className="account-hint">
        Saving checks the settings against the servers first — settings that do not work are not
        stored.
      </p>
    </section>
  )
}

// One account: what it is, what it holds, and the two things you can change.
function AccountDetail({ account }: { account: Account }) {
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(account.displayName)
  const [savingName, setSavingName] = useState(false)
  const [syncDays, setSyncDays] = useState(account.syncDays)
  const [savingSyncDays, setSavingSyncDays] = useState(false)
  const [syncing, setSyncing] = useState(false)
  // Removal deletes this account's cached mail, so it is a two-step confirm
  // inside the pane rather than a window.confirm — an OS dialog stacked on a
  // modal, which is what this used to be, cannot say how much is about to go.
  const [confirmingRemove, setConfirmingRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const loadInfo = () => {
    let cancelled = false
    setLoadError(null)
    void window.orbitMail.accounts
      .getInfo(account.id)
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        setSyncDays(result.syncDays)
      })
      .catch((err) => {
        if (!cancelled) setLoadError(ipcErrorMessage(err, 'Could not load this account'))
      })
    return () => {
      cancelled = true
    }
  }

  // Reload whenever the selected account changes, and reset the drafts with it
  // so a half-typed name cannot follow you to another account.
  useEffect(() => {
    setDisplayName(account.displayName)
    setSyncDays(account.syncDays)
    setConfirmingRemove(false)
    return loadInfo()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id])

  const nameChanged = displayName.trim().length > 0 && displayName.trim() !== account.displayName

  const handleSaveName = async () => {
    if (!nameChanged) return
    setSavingName(true)
    try {
      await updateAccountDisplayName(account.id, displayName.trim())
      loadInfo()
    } finally {
      setSavingName(false)
    }
  }

  const handleSaveSyncDays = async () => {
    if (!info || syncDays === info.syncDays) return
    setSavingSyncDays(true)
    try {
      await updateAccountSyncDays(account.id, syncDays)
      loadInfo()
      await refreshMessages()
    } catch {
      // the store toasts
    } finally {
      setSavingSyncDays(false)
    }
  }

  const handleSyncNow = async () => {
    setSyncing(true)
    try {
      await syncAccountById(account.id)
      loadInfo()
    } finally {
      setSyncing(false)
    }
  }

  const handleRemove = async () => {
    setRemoving(true)
    try {
      await removeAccountById(account.id)
    } finally {
      setRemoving(false)
    }
  }

  return (
    <>
      <section className="settings-section">
        <h3>{accountLabel(account)}</h3>

        <label className="account-field">
          <span>Display name</span>
          <div className="account-field-row">
            <input
              value={displayName}
              disabled={savingName}
              onChange={(event) => setDisplayName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSaveName()
              }}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={!nameChanged || savingName}
              onClick={() => void handleSaveName()}
            >
              {savingName ? 'Saving…' : 'Save'}
            </button>
          </div>
        </label>

        <label className="account-field">
          <span>Keep mail locally</span>
          <div className="account-field-row">
            <select
              value={syncDays}
              disabled={savingSyncDays || !info}
              onChange={(event) => setSyncDays(Number(event.target.value))}
            >
              {SYNC_WINDOW_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={savingSyncDays || !info || syncDays === info.syncDays}
              onClick={() => void handleSaveSyncDays()}
            >
              {savingSyncDays ? 'Saving…' : 'Apply'}
            </button>
          </div>
        </label>
        <p className="account-hint">
          Mail older than this window is removed from this computer — it stays on the server.
          Attachments download when you open them.
        </p>
      </section>

      <section className="settings-section">
        <h3>This account</h3>
        {loadError ? (
          <p className="account-hint">{loadError}</p>
        ) : !info ? (
          <p className="account-hint">Loading…</p>
        ) : (
          <dl className="account-info-list">
            <div className="account-info-row">
              <dt>Email</dt>
              <dd>{info.email}</dd>
            </div>
            <div className="account-info-row">
              <dt>Type</dt>
              <dd>{info.providerLabel}</dd>
            </div>
            <div className="account-info-row">
              <dt>Added</dt>
              <dd>{formatDate(info.createdAt)}</dd>
            </div>
            <div className="account-info-row">
              <dt>Mailboxes</dt>
              <dd>{info.folderCount}</dd>
            </div>
            <div className="account-info-row">
              <dt>Messages</dt>
              <dd>
                {info.messageCount.toLocaleString()}
                {info.unreadCount > 0 && ` (${info.unreadCount.toLocaleString()} unread)`}
              </dd>
            </div>
            <div className="account-info-row">
              <dt>On this computer</dt>
              <dd>{formatBytes(info.localStorageBytes)}</dd>
            </div>
            <div className="account-info-row">
              <dt>Attachments</dt>
              <dd>
                {info.downloadedAttachmentCount.toLocaleString()} downloaded of{' '}
                {info.attachmentCount.toLocaleString()}
              </dd>
            </div>
          </dl>
        )}
        <div className="settings-section-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={syncing}
            onClick={() => void handleSyncNow()}
          >
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        </div>
      </section>

      <SignatureSettings account={account} info={info} onSaved={loadInfo} />

      <ConnectionSettings account={account} />

      <section className="settings-section">
        <h3>Remove account</h3>
        {confirmingRemove ? (
          <>
            <p className="account-hint">
              This deletes {info ? info.messageCount.toLocaleString() : 'the'} cached message
              {info && info.messageCount === 1 ? '' : 's'} and{' '}
              {info ? formatBytes(info.localStorageBytes) : 'the data'} stored on this computer for{' '}
              {account.email}, along with its saved credentials, tasks and collected addresses.
              Nothing on the mail server is touched.
            </p>
            <div className="settings-section-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={removing}
                onClick={() => setConfirmingRemove(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={removing}
                onClick={() => void handleRemove()}
              >
                {removing ? 'Removing…' : `Remove ${account.email}`}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="account-hint">
              Removes this account and everything cached for it from this computer. Your mail stays
              on the server.
            </p>
            <div className="settings-section-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmingRemove(true)}
              >
                Remove account…
              </button>
            </div>
          </>
        )}
      </section>
    </>
  )
}

export function AccountsPane() {
  const accounts = useMailStore((s) => s.accounts)
  const aimedAt = useMailStore((s) => s.settingsAccountId)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    resolveSelectedAccountId(accounts, aimedAt, null)
  )

  // Follow the account Settings was opened for, and recover if the selected one
  // is removed — including while the dialog sits open.
  useEffect(() => {
    const next = resolveSelectedAccountId(accounts, aimedAt, selectedId)
    if (next !== selectedId) setSelectedId(next)
  }, [aimedAt, accounts, selectedId])

  const selected = accounts.find((a) => a.id === selectedId) ?? null

  if (accounts.length === 0) {
    return (
      <section className="settings-section">
        <h3>Accounts</h3>
        <p className="account-hint">No accounts yet.</p>
        <div className="settings-section-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setShowAddAccount(true)}
          >
            Add an account
          </button>
        </div>
      </section>
    )
  }

  return (
    <div className="settings-accounts">
      {accounts.length > 1 && (
        <div className="settings-account-picker" role="tablist" aria-label="Accounts">
          {accounts.map((account) => (
            <button
              key={account.id}
              type="button"
              role="tab"
              aria-selected={account.id === selectedId}
              className={`settings-account-tab${account.id === selectedId ? ' is-active' : ''}`}
              onClick={() => setSelectedId(account.id)}
              title={account.email}
            >
              {accountLabel(account)}
            </button>
          ))}
        </div>
      )}
      {selected && <AccountDetail key={selected.id} account={selected} />}
      <div className="settings-section-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setShowAddAccount(true)}
        >
          Add another account
        </button>
      </div>
    </div>
  )
}
