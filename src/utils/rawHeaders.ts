// Pure helpers for the "View headers" dialog. String work only, so test:store
// can bundle and drive it under plain node.
//
// None of this is a verdict. The dialog exists for a person reading headers by
// hand; these just pull out the parts they usually go looking for first. The
// raw block is always shown in full beside them, because anything parsed here
// can be wrong about a header some server wrote in its own dialect.

export interface HeaderField {
  name: string
  value: string
}

/**
 * Split a header block into fields, unfolding continuation lines (RFC 5322
 * §2.2.3: a line starting with whitespace continues the previous field).
 * Order is preserved — for Received it is the whole point.
 */
export function parseHeaderFields(raw: string): HeaderField[] {
  const fields: HeaderField[] = []
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (/^[ \t]/.test(line)) {
      const last = fields[fields.length - 1]
      if (last) last.value = `${last.value} ${line.trim()}`.trim()
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    fields.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() })
  }
  return fields
}

export interface AuthVerdict {
  /** spf, dkim, dmarc, arc, … as the header names it, lower-cased. */
  method: string
  /** pass, fail, softfail, none, … lower-cased. */
  result: string
}

/**
 * The method=result pairs from every Authentication-Results header, plus
 * Received-SPF's leading verdict. Repeats are kept: a message relayed through
 * several filters carries several, and disagreement between them is worth
 * seeing.
 */
export function authVerdicts(fields: HeaderField[]): AuthVerdict[] {
  const verdicts: AuthVerdict[] = []
  for (const f of fields) {
    const name = f.name.toLowerCase()
    if (name === 'authentication-results' || name === 'arc-authentication-results') {
      for (const m of f.value.matchAll(/(?:^|[;\s])(spf|dkim|dmarc|arc|bimi|dkim-atps|iprev|auth|smime|compauth)=([a-z]+)/gi)) {
        verdicts.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase() })
      }
    } else if (name === 'received-spf') {
      const m = f.value.match(/^([a-z]+)/i)
      if (m) verdicts.push({ method: 'spf', result: m[1].toLowerCase() })
    }
  }
  return verdicts
}

export interface ReceivedHop {
  from: string | null
  by: string | null
  with: string | null
  /** Epoch ms of the hop's timestamp, or null if it has none or it won't parse. */
  time: number | null
  /** Seconds since the previous hop, or null when either time is unknown. */
  delaySeconds: number | null
}

/**
 * Received headers in delivery order — oldest first. Each server prepends its
 * own, so the header block lists them newest first; reversing gives the path
 * the message actually took.
 */
export function receivedHops(fields: HeaderField[]): ReceivedHop[] {
  const hops: ReceivedHop[] = fields
    .filter((f) => f.name.toLowerCase() === 'received')
    .reverse()
    .map((f) => {
      const semi = f.value.lastIndexOf(';')
      const parsed = semi < 0 ? NaN : Date.parse(f.value.slice(semi + 1).trim())
      const clause = (word: string) =>
        f.value.match(new RegExp(`(?:^|\\s)${word}\\s+([^\\s;]+)`, 'i'))?.[1] ?? null
      return {
        from: clause('from'),
        by: clause('by'),
        with: clause('with'),
        time: Number.isNaN(parsed) ? null : parsed,
        delaySeconds: null
      }
    })
  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1].time
    const cur = hops[i].time
    if (prev !== null && cur !== null) hops[i].delaySeconds = Math.round((cur - prev) / 1000)
  }
  return hops
}
