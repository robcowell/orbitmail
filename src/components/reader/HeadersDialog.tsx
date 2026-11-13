import { useEffect, useMemo, useState } from 'react'
import { useMailStore } from '../../stores/mailStore'
import { ipcErrorMessage } from '../../utils/ipcError'
import { authVerdicts, parseHeaderFields, receivedHops, spamHeaders } from '../../utils/rawHeaders'

interface HeadersDialogProps {
  messageId: string
  onClose: () => void
}

type View = 'raw' | 'summary'

// Full message headers, fetched from the server when opened. Everything shown
// is sender- and relay-controlled text, so it is only ever rendered as text.
export function HeadersDialog({ messageId, onClose }: HeadersDialogProps) {
  const setToast = useMailStore((s) => s.setToast)
  const [raw, setRaw] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>('raw')

  useEffect(() => {
    let live = true
    setRaw(null)
    setError(null)
    window.orbitMail.messages
      .getHeaders(messageId)
      .then((text) => live && setRaw(text))
      .catch((err) => live && setError(ipcErrorMessage(err, 'Could not fetch headers')))
    return () => {
      live = false
    }
  }, [messageId])

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

  const copy = () => {
    if (raw === null) return
    navigator.clipboard
      .writeText(raw)
      .then(() => setToast('Headers copied'))
      .catch(() => setToast('Could not copy headers'))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal headers-modal"
        role="dialog"
        aria-label="Message headers"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="headers-modal-head">
          <h2>Message headers</h2>
          <div className="tasks-scope" role="group" aria-label="Header view">
            {(['raw', 'summary'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`tasks-scope-btn${view === v ? ' is-active' : ''}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === 'raw' ? 'Raw' : 'Summary'}
              </button>
            ))}
          </div>
        </div>

        <div className="headers-modal-body">
          {error ? (
            <p className="headers-error">{error}</p>
          ) : raw === null ? (
            <p className="tasks-loading">Fetching headers from the server…</p>
          ) : view === 'raw' ? (
            <pre className="headers-raw">{raw}</pre>
          ) : (
            <HeaderSummary raw={raw} />
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" disabled={raw === null} onClick={copy}>
            Copy
          </button>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function HeaderSummary({ raw }: { raw: string }) {
  const { verdicts, hops, spam } = useMemo(() => {
    const fields = parseHeaderFields(raw)
    return { verdicts: authVerdicts(fields), hops: receivedHops(fields), spam: spamHeaders(fields) }
  }, [raw])

  return (
    <div className="headers-summary">
      <section>
        <h3>Authentication</h3>
        {verdicts.length === 0 ? (
          <p className="headers-none">No Authentication-Results or Received-SPF headers.</p>
        ) : (
          <div className="headers-verdicts">
            {verdicts.map((v, i) => (
              <span key={i} className={`headers-verdict is-${verdictTone(v.result)}`}>
                {v.method.toUpperCase()} {v.result}
              </span>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>Delivery path ({hops.length} {hops.length === 1 ? 'hop' : 'hops'}, oldest first)</h3>
        {hops.length === 0 ? (
          <p className="headers-none">No Received headers.</p>
        ) : (
          <ol className="headers-hops">
            {hops.map((h, i) => (
              <li key={i}>
                <div>
                  <span className="headers-hop-label">from</span> {h.from ?? '—'}{' '}
                  <span className="headers-hop-label">by</span> {h.by ?? '—'}
                  {h.with && (
                    <>
                      {' '}
                      <span className="headers-hop-label">with</span> {h.with}
                    </>
                  )}
                </div>
                <div className="headers-hop-time">
                  {h.time !== null ? new Date(h.time).toLocaleString() : 'No timestamp'}
                  {h.delaySeconds !== null && ` · ${formatDelay(h.delaySeconds)}`}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section>
        <h3>Spam filter headers</h3>
        {spam.length === 0 ? (
          <p className="headers-none">None found. Check the raw view for filters with other names.</p>
        ) : (
          <dl className="headers-fields">
            {spam.map((f, i) => (
              <div key={i}>
                <dt>{f.name}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </div>
  )
}

function verdictTone(result: string): 'pass' | 'fail' | 'neutral' {
  if (result === 'pass') return 'pass'
  if (['fail', 'softfail', 'permerror', 'temperror', 'hardfail'].includes(result)) return 'fail'
  return 'neutral'
}

// Clock skew between relays makes negative delays common; show them as-is
// rather than hiding them — they are part of what someone reading a path needs.
function formatDelay(seconds: number): string {
  const abs = Math.abs(seconds)
  const sign = seconds < 0 ? '−' : '+'
  if (abs < 60) return `${sign}${abs}s`
  if (abs < 3600) return `${sign}${Math.round(abs / 60)}m`
  return `${sign}${Math.round(abs / 3600)}h`
}
