import { useMailStore, addAccount } from '../../stores/mailStore'

export function AddAccountWizard() {
  const show = useMailStore((s) => s.showAddAccount)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const accounts = useMailStore((s) => s.accounts)

  if (!show) return null

  return (
    <div className="modal-overlay" onClick={() => setShowAddAccount(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add Email Account</h2>
        <p>
          Connect a Gmail or Microsoft 365 account using OAuth. Ensure your OAuth
          credentials are configured in <code>.env</code>.
        </p>
        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={() => addAccount('gmail')}>
            Gmail
          </button>
          <button className="btn btn-primary" onClick={() => addAccount('o365')}>
            Microsoft 365
          </button>
        </div>
        {accounts.length > 0 && (
          <button
            className="btn btn-secondary"
            style={{ marginTop: 12, width: '100%' }}
            onClick={() => setShowAddAccount(false)}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  )
}
