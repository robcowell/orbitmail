import { useEffect, useState } from 'react'
import type { AppVersionInfo } from '../../../shared/types'

const REPO = 'https://github.com/robcowell/orbitmail'
const WEBSITE = 'https://robcowell.github.io/orbit-website/'

function open(url: string) {
  void window.orbitMail.shell.openExternal(url)
}

export function AboutPane() {
  const [info, setInfo] = useState<AppVersionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.orbitMail.app.getVersionInfo().then((next) => {
      if (!cancelled) setInfo(next)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <>
      <section className="settings-section">
        <h3>Orbit Mail</h3>
        <p className="account-hint">
          {info ? `Version ${info.version}` : 'Version …'} · MIT licensed
        </p>
        {info && (
          <p className="account-hint">
            Electron {info.electron} · Chromium {info.chromium} · Node {info.node}
          </p>
        )}
        <div className="settings-section-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={!info}
            onClick={() => info && open(`${REPO}/releases/tag/v${info.version}`)}
          >
            Release notes
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => open(WEBSITE)}>
            Website
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => open(`${REPO}/issues`)}>
            Report a problem
          </button>
        </div>
      </section>
    </>
  )
}
