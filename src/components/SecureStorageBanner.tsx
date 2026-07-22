import { useEffect, useState } from 'react'
import { WarningCircle } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { X } from '@phosphor-icons/react/dist/ssr/X'

// Shown when the OS has no keyring, so Electron's safeStorage cannot encrypt.
// In that state every stored secret — IMAP passwords, OAuth tokens, the
// Anthropic API key — is only base64-obfuscated on disk, which the code falls
// back to silently. This makes that visible. Dismissible for the session; it
// reappears next launch while the condition holds, because it is a real,
// ongoing property of the machine, not a one-off event.
export function SecureStorageBanner() {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let active = true
    window.orbitMail.app
      .getSecureStorageStatus()
      .then((status) => {
        if (active) setAvailable(status.available)
      })
      .catch(() => {
        // If we cannot tell, say nothing rather than warn spuriously.
        if (active) setAvailable(true)
      })
    return () => {
      active = false
    }
  }, [])

  if (available !== false || dismissed) return null

  return (
    <div className="secure-storage-banner" role="alert">
      <WarningCircle size={16} weight="fill" />
      <span>
        No system keyring found, so saved passwords, access tokens and API keys are
        stored obfuscated on this machine — not encrypted. Install a keyring (e.g.
        gnome-keyring or kwallet) for encryption at rest.
      </span>
      <button
        type="button"
        className="secure-storage-banner-dismiss"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
      >
        <X size={14} weight="bold" />
      </button>
    </div>
  )
}
