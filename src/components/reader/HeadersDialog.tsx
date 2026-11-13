import { useEffect, useMemo, useState } from 'react'
import { useMailStore } from '../../stores/mailStore'
import { ipcErrorMessage } from '../../utils/ipcError'
import {
  authVerdicts,
  parseHeaderFields,
  receivedHops,
  type HeaderField
} from '../../utils/rawHeaders'

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
  const { fields, verdicts, hops } = useMemo(() => {
    const fields = parseHeaderFields(raw)
    return {
      fields,
      verdicts: authVerdicts(fields),
      hops: receivedHops(fields)
    }
  }, [raw])

  return (
    <div className="headers-summary">
      <Section title="Authentication">
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
      </Section>

      <Section
        title={`Delivery path (${hops.length} ${hops.length === 1 ? 'hop' : 'hops'}, oldest first)`}
      >
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
      </Section>

      <Section title={`All headers (${fields.length}, as the server lists them)`}>
        <HeaderFieldList fields={fields} />
      </Section>
    </div>
  )
}

// A collapsible section of the summary, open to begin with.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="headers-section" open>
      <summary>{title}</summary>
      <div className="headers-section-body">{children}</div>
    </details>
  )
}

// One collapsible row per header: the name (and a one-line preview while
// closed), with the full value beneath when opened. Repeats such as Received
// stay separate rows, in order — merging them would lose the path.
function HeaderFieldList({ fields }: { fields: HeaderField[] }) {
  return (
    <div className="headers-fields">
      {fields.map((f, i) => (
        <details key={i} className="headers-field">
          <summary>
            <span className="headers-field-name">{f.name}</span>
            <span className="headers-field-preview">{f.value}</span>
          </summary>
          <div className="headers-field-value">{f.value || '(empty)'}</div>
        </details>
      ))}
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
