import { useEffect, useState } from 'react'
import type { AccountInfo } from '../../../shared/types'
import { useMailStore } from '../../stores/mailStore'

interface AccountInfoDialogProps {
  accountId: string
  onClose: () => void
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  })
}

export function AccountInfoDialog({ accountId, onClose }: AccountInfoDialogProps) {
  const setToast = useMailStore((s) => s.setToast)
  const [info, setInfo] = useState<AccountInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.orbitMail.accounts
      .getInfo(accountId)
      .then((result) => {
        if (!cancelled) setInfo(result)
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>Account Info</h2>
        {loading || !info ? (
          <p>Loading account details…</p>
        ) : (
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
          </dl>
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
