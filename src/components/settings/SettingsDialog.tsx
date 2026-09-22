import { useEffect, useRef } from 'react'
import { useMailStore, type SettingsCategory } from '../../stores/mailStore'
import { AccountsPane } from './AccountsPane'
import { GeneralPane } from './GeneralPane'
import { PrivacyPane } from './PrivacyPane'
import { AiPane } from './AiPane'
import { AboutPane } from './AboutPane'

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'privacy', label: 'Privacy' },
  { id: 'ai', label: 'AI' },
  { id: 'about', label: 'About' }
]

interface SettingsDialogProps {
  onClose: () => void
}

export function SettingsDialog({ onClose }: SettingsDialogProps) {
  const category = useMailStore((s) => s.settingsCategory)
  const setCategory = useMailStore((s) => s.setSettingsCategory)
  const navRef = useRef<HTMLDivElement>(null)

  // Escape closes. The other dialogs in this app mostly do not handle it, which
  // is a gap rather than a convention worth copying.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  // Arrow keys move between categories, as a tablist should.
  const handleNavKeyDown = (event: React.KeyboardEvent) => {
    const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()
    const index = CATEGORIES.findIndex((c) => c.id === category)
    const next = CATEGORIES[(index + delta + CATEGORIES.length) % CATEGORIES.length]
    setCategory(next.id)
    navRef.current?.querySelector<HTMLButtonElement>(`[data-category="${next.id}"]`)?.focus()
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal modal-settings"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="settings-body">
          <div
            className="settings-nav"
            role="tablist"
            aria-orientation="vertical"
            ref={navRef}
            onKeyDown={handleNavKeyDown}
          >
            <h2 className="settings-title">Settings</h2>
            {CATEGORIES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="tab"
                data-category={entry.id}
                aria-selected={category === entry.id}
                tabIndex={category === entry.id ? 0 : -1}
                className={`settings-nav-item${category === entry.id ? ' is-active' : ''}`}
                onClick={() => setCategory(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>

          <div className="settings-pane" role="tabpanel">
            {category === 'general' && <GeneralPane />}
            {category === 'privacy' && <PrivacyPane />}
            {category === 'ai' && <AiPane />}
            {category === 'accounts' && <AccountsPane />}
            {category === 'about' && <AboutPane />}
          </div>
        </div>

        <div className="modal-actions">
          <span className="modal-actions-spacer" />
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
