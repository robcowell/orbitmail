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

// Build a LIKE pattern from a user query: keep word chars, whitespace, `@` and
// `.`; everything else becomes a word break, joined with `%` so terms match in
// order with anything between. LIKE reads `_` (and `%`) as wildcards, and `\w`
// keeps `_`, so a search for `foo_bar` used to also match `fooXbar`. The literal
// wildcards a query can still contain are escaped with a backslash — callers
// must pair this with `ESCAPE '\'` so the underscore matches literally.
export function buildLikePattern(text: string): string | null {
  const query = text.replace(/[^\w\s@.]/g, ' ').trim()
  if (!query) return null
  const escaped = query.replace(/[\\_%]/g, '\\$&')
  return `%${escaped.replace(/\s+/g, '%')}%`
}
