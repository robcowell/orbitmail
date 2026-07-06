// Threading helpers: derive a stable per-conversation key from RFC 5322 headers.

// Collapse a subject to a thread-grouping key: strip repeated leading reply/
// forward prefixes (Re:, Fwd:, Fw:), whitespace-normalize, and lowercase.
export function normalizeSubject(subject: string | null | undefined): string {
  return (subject ?? '')
    .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Normalize a raw References/In-Reply-To header (mailparser may hand back a
// string or string[]) into a single space-separated string of Message-IDs.
export function normalizeReferences(value: string | string[] | null | undefined): string | null {
  if (!value) return null
  const joined = Array.isArray(value) ? value.join(' ') : value
  const trimmed = joined.replace(/\s+/g, ' ').trim()
  return trimmed.length > 0 ? trimmed : null
}

function firstToken(value: string | null | undefined): string | null {
  if (!value) return null
  const first = value.trim().split(/\s+/)[0]
  return first && first.length > 0 ? first : null
}

// Derive the conversation id for a message. References[0] is the RFC thread root
// (present in every reply's chain, across Inbox and Sent), so it groups the whole
// conversation. Fall back to the immediate parent, then the message's own id, and
// finally a normalized-subject key when no threading headers exist at all.
export function computeThreadId(input: {
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | null
  subject?: string | null
}): string {
  const root = firstToken(input.references) ?? firstToken(input.inReplyTo) ?? input.messageId
  if (root && root.length > 0) return root
  return `subj:${normalizeSubject(input.subject)}`
}
