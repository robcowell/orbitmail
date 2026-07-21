// Local search helpers. Search runs as a scope-aware LIKE over the messages
// table (see searchMessages in db-service.ts); there is no full-text index.
//
// A contentless FTS5 table used to be maintained here, written on every synced
// message. Nothing ever queried it — the search path has always used LIKE — and
// its deletes could not work (a contentless table cannot match on a column
// value), so it accumulated orphans forever. It was removed rather than
// repaired; see TODO.md if full-text search is wanted later.

export function buildLikePattern(text: string): string | null {
  const query = text.replace(/[^\w\s@.]/g, ' ').trim()
  if (!query) return null
  return `%${query.replace(/\s+/g, '%')}%`
}
