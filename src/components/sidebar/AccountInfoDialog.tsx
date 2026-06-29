import { useEffect, useState } from 'react'
import type { AccountInfo } from '../../../shared/types'
import { refreshMessages, updateAccountSyncDays, useMailStore } from '../../stores/mailStore'

interface AccountInfoDialogProps {
  accountId: string
  onClose: () => void
}

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

function syncWindowLabel(syncDays: number): string {
  return SYNC_WINDOW_OPTIONS.find((option) => option.value === syncDays)?.label ?? `${syncDays} days`
}

export function AccountInfoDialog({ accountId, onClose }: AccountInfoDialogProps) {
  const setToast = useMailStore((s) => s.setToast)
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncDays, setSyncDays] = useState(90)
  const [savingSyncDays, setSavingSyncDays] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.orbitMail.accounts
      .getInfo(accountId)
      .then((result) => {
        if (cancelled) return
        setInfo(result)
        setSyncDays(result.syncDays)
      })
      .catch((err) => {
        setToast(err instanceof Error ? err.message : 'Failed to load account info')
        onClose()
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [accountId, onClose, setToast])

  const handleSaveSyncDays = async () => {
    if (!info || syncDays === info.syncDays) return

    setSavingSyncDays(true)
    try {
      await updateAccountSyncDays(accountId, syncDays)
      const refreshed = await window.orbitMail.accounts.getInfo(accountId)
      setInfo(refreshed)
      setSyncDays(refreshed.syncDays)
      await refreshMessages()
    } catch {
      // toast handled in store
    } finally {
      setSavingSyncDays(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Account Info</h2>
        {loading || !info ? (
          <p>Loading account details…</p>
        ) : (
          <>
            <dl className="account-info-list">
              <div className="account-info-row">
                <dt>Email</dt>
                <dd>{info.email}</dd>
              </div>
              <div className="account-info-row">
                <dt>Display name</dt>
                <dd>{info.displayName}</dd>
              </div>
              <div className="account-info-row">
                <dt>Provider</dt>
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
                <dd>{info.messageCount.toLocaleString()}</dd>
              </div>
              <div className="account-info-row">
                <dt>Unread</dt>
                <dd>{info.unreadCount.toLocaleString()}</dd>
              </div>
              <div className="account-info-row">
                <dt>Local storage</dt>
                <dd>{formatBytes(info.localStorageBytes)}</dd>
              </div>
              <div className="account-info-row">
                <dt>Attachments</dt>
                <dd>
                  {info.downloadedAttachmentCount.toLocaleString()} downloaded of{' '}
                  {info.attachmentCount.toLocaleString()}
                </dd>
              </div>
              <div className="account-info-row">
                <dt>Sync window</dt>
                <dd>{syncWindowLabel(info.syncDays)}</dd>
              </div>
            </dl>

            <label className="account-field">
              <span>Keep mail locally</span>
              <div className="account-field-row">
                <select
                  value={syncDays}
                  disabled={savingSyncDays}
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
                  disabled={savingSyncDays || syncDays === info.syncDays}
                  onClick={() => void handleSaveSyncDays()}
                >
                  {savingSyncDays ? 'Saving…' : 'Apply'}
                </button>
              </div>
            </label>
            <p className="account-hint">
              Older messages outside this window are removed locally. Attachments download when
              you open them.
            </p>
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
