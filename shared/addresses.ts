// RFC 5322 address helpers shared by the main process (thread summaries) and the
// renderer (message list rows) — both need to turn a raw header value into the
// names a human reads in a list.

// Display name of a single address: `Rob Cowell <rob@x>` → `Rob Cowell`; a bare
// address is returned as-is.
export function extractName(address: string): string {
  const match = address.match(/^(.+?)\s*</)
  if (match) return match[1].replace(/"/g, '').trim()
  return address.trim()
}

// Split a raw address list on the commas that actually separate addresses —
// those outside a quoted display name and outside the angle-bracketed address,
// so `"Smith, John" <j@x>, a@y` is two addresses, not three.
export function splitAddressList(list: string): string[] {
  const parts: string[] = []
  let current = ''
  let inQuotes = false
  let inAngle = false
  for (const ch of list) {
    if (ch === ',' && !inQuotes && !inAngle) {
      parts.push(current)
      current = ''
      continue
    }
    if (ch === '"') inQuotes = !inQuotes
    else if (ch === '<' && !inQuotes) inAngle = true
    else if (ch === '>' && !inQuotes) inAngle = false
    current += ch
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part.length > 0)
}

// The mailbox part of an address, lowercased: `Ann <a@x>` → `a@x`. Everything
// that decides *who* an address is must compare this, never the raw header —
// the display name is attacker-controlled, so `"you@yours" <them@theirs>`
// contains your address without being from you.
export function extractAddress(address: string): string {
  const angle = address.match(/<([^>]*)>/)
  const mailbox = (angle ? angle[1] : address).trim().toLowerCase()
  return mailbox || address.trim().toLowerCase()
}

// Dedupe key for an address: the mailbox part when there is one, so the same
// person written two ways (`a@x` in one message, `Ann <a@x>` in the next) is one
// participant rather than two.
function addressKey(address: string): string {
  return extractAddress(address)
}

// Display names across one or more raw address lists, first-seen order, one name
// per distinct address. A later mention carrying a real display name replaces an
// earlier bare address, and a name that survives twice (one person, two
// addresses) is listed once — "Ray Johnson, Ray Johnson" reads as a bug.
export function collectDisplayNames(lists: string[]): string[] {
  const order: string[] = []
  const names = new Map<string, string>()
  for (const list of lists) {
    for (const address of splitAddressList(list)) {
      const name = extractName(address)
      if (!name) continue
      const key = addressKey(address)
      const existing = names.get(key)
      if (existing === undefined) {
        order.push(key)
        names.set(key, name)
      } else if (existing.toLowerCase() === key && name.toLowerCase() !== key) {
        names.set(key, name)
      }
    }
  }
  const seenNames = new Set<string>()
  const result: string[] = []
  for (const key of order) {
    const name = names.get(key) as string
    const folded = name.toLowerCase()
    if (seenNames.has(folded)) continue
    seenNames.add(folded)
    result.push(name)
  }
  return result
}
