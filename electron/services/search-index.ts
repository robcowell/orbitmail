import type Database from 'better-sqlite3'

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

export function buildFtsQuery(text: string): string | null {
  const terms = text
    .replace(/[^\w\s@.]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)

  if (!terms.length) return null
  if (terms.length === 1) return `${terms[0]}*`
  return terms.map((term, index) => (index === terms.length - 1 ? `${term}*` : term)).join(' AND ')
}

export function buildLikePattern(text: string): string | null {
  const query = text.replace(/[^\w\s@.]/g, ' ').trim()
  if (!query) return null
  return `%${query.replace(/\s+/g, '%')}%`
}

type MessageRow = {
  id: string
  subject: string
  snippet: string
  body_text: string | null
  body_html: string | null
}

// Prepared once and reused for the whole app lifetime — indexMessageInFts runs
// on every message upserted during a sync, so this is the hottest raw-SQL path.
// (The DB is a process-lifetime singleton, so binding to the first db is safe.)
let ftsDeleteStmt: Database.Statement | null = null
let ftsInsertStmt: Database.Statement | null = null

export function indexMessageInFts(
  db: Database.Database,
  messageId: string,
  subject: string,
  snippet: string,
  bodyText?: string | null,
  bodyHtml?: string | null
): void {
  if (!ftsDeleteStmt || !ftsInsertStmt) {
    ftsDeleteStmt = db.prepare('DELETE FROM messages_fts WHERE message_id = ?')
    ftsInsertStmt = db.prepare(
      'INSERT INTO messages_fts (message_id, subject, snippet, body_text) VALUES (?, ?, ?, ?)'
    )
  }
  ftsDeleteStmt.run(messageId)
  ftsInsertStmt.run(messageId, subject, snippet, messageSearchableBody(bodyText, bodyHtml))
}

export function migrateFtsIndex(db: Database.Database): void {
  const migrated = db
    .prepare("SELECT value FROM app_preferences WHERE key = 'fts_index_v2'")
    .get() as { value: string } | undefined

  if (migrated?.value === '1') return

  db.exec('DELETE FROM messages_fts')

  const rows = db
    .prepare(
      'SELECT id, subject, snippet, body_text, body_html FROM messages ORDER BY date DESC'
    )
    .all() as MessageRow[]

  const insert = db.prepare(
    'INSERT INTO messages_fts (message_id, subject, snippet, body_text) VALUES (?, ?, ?, ?)'
  )

  const rebuild = db.transaction((messages: MessageRow[]) => {
    for (const row of messages) {
      insert.run(
        row.id,
        row.subject,
        row.snippet,
        messageSearchableBody(row.body_text, row.body_html)
      )
    }
  })

  rebuild(rows)

  db.prepare(
    "INSERT INTO app_preferences (key, value) VALUES ('fts_index_v2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run()
}
