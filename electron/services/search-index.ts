// Local search helpers. Search runs as a scope-aware LIKE over the messages
// table (see searchMessages in db-service.ts); there is no full-text index.
//
// A contentless FTS5 table used to be maintained here, written on every synced
// message. Nothing ever queried it — the search path has always used LIKE — and
// its deletes could not work (a contentless table cannot match on a column
// value), so it accumulated orphans forever. It was removed rather than
// repaired; see TODO.md if full-text search is wanted later.

// Plain, searchable text for a message: its text/plain part when present, else
// its HTML stripped of tags and the common entities. This is what the stored
// search_text column holds, so search matches content rather than markup — a
// query for "div" no longer hits every <div>.
export function messageSearchableBody(
  bodyText?: string | null,
  bodyHtml?: string | null
): string {
  if (bodyText?.trim()) return bodyText
  if (!bodyHtml) return ''
  return bodyHtml
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

export function buildLikePattern(text: string): string | null {
  const query = text.replace(/[^\w\s@.]/g, ' ').trim()
  if (!query) return null
  return `%${query.replace(/\s+/g, '%')}%`
}
