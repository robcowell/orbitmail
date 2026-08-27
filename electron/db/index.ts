import { app } from 'electron'
import { join } from 'path'
import { ensurePrivateDir, restrictDatabaseFiles } from './permissions'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { normalizeSubject } from '../services/thread-util'

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null
let sqliteInstance: Database.Database | null = null

export function getDataDir(): string {
  return ensurePrivateDir(join(app.getPath('userData'), 'data'))
}

export function getAttachmentsDir(): string {
  return ensurePrivateDir(join(getDataDir(), 'attachments'))
}

/**
 * Tighten every directory we own, whether or not anything has used it yet.
 *
 * getAttachmentsDir() is otherwise reached only when an attachment is fetched,
 * so an install could keep a world-readable attachments directory indefinitely
 * — which is what the first profile checked after the permissions fix actually
 * did: database corrected to 0600, attachments still 0775. Startup must not
 * depend on the user happening to open an attachment.
 */
export function restrictDataDirectories(): void {
  getDataDir()
  getAttachmentsDir()
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token_blob TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      sync_days INTEGER NOT NULL DEFAULT 90,
      signature TEXT
    );

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      imap_path TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      unread_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS folders_account_idx ON folders(account_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      uid INTEGER NOT NULL,
      message_id TEXT,
      in_reply_to TEXT,
      "references" TEXT,
      thread_id TEXT,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      cc TEXT,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      date INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      flag_color TEXT,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      body_html TEXT,
      body_text TEXT,
      search_text TEXT,
      server_uid TEXT,
      ai_analysis TEXT,
      ai_analysis_at INTEGER,
      sweep_cache TEXT,
      sweep_cache_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx ON scheduled_actions(due_at);

    CREATE INDEX IF NOT EXISTS messages_folder_date_idx ON messages(folder_id, date);
    CREATE INDEX IF NOT EXISTS messages_account_date_idx ON messages(account_id, date);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      local_path TEXT,
      is_inline INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id);

    CREATE TABLE IF NOT EXISTS app_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sweep_tasks (
      folder_id TEXT NOT NULL,
      id TEXT NOT NULL,
      task TEXT NOT NULL,
      priority TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_subject TEXT NOT NULL,
      source_from TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT NOT NULL DEFAULT 'sweep',
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY (folder_id, id)
    );

    CREATE INDEX IF NOT EXISTS sweep_tasks_folder_idx ON sweep_tasks(folder_id);

    CREATE TABLE IF NOT EXISTS pop3_skipped (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      server_uid TEXT NOT NULL,
      message_date INTEGER NOT NULL,
      PRIMARY KEY (account_id, server_uid)
    );

    CREATE TABLE IF NOT EXISTS thread_analysis (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      json TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      analyzed_count INTEGER NOT NULL,
      latest_message_id TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id)
    );

    CREATE TABLE IF NOT EXISTS contacts (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      address TEXT NOT NULL,
      name TEXT,
      sent_count INTEGER NOT NULL DEFAULT 0,
      seen_count INTEGER NOT NULL DEFAULT 0,
      last_seen_at INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, address)
    );

    CREATE INDEX IF NOT EXISTS contacts_account_idx ON contacts(account_id);

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      to_addr TEXT NOT NULL DEFAULT '',
      cc TEXT NOT NULL DEFAULT '',
      bcc TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      quoted_html TEXT,
      quoted_text TEXT,
      in_reply_to TEXT,
      -- Quoted: REFERENCES is a SQL keyword, and an unquoted column of that
      -- name is a syntax error. The messages table does the same.
      "references" TEXT,
      mode TEXT,
      original_message_id TEXT,
      attachment_paths TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS drafts_account_idx ON drafts(account_id);
  `)

  migrateSchema(db)
}

function migrateSchema(db: Database.Database): void {
  const folderCols = db.prepare('PRAGMA table_info(folders)').all() as Array<{ name: string }>
  const folderNames = new Set(folderCols.map((c) => c.name))

  if (!folderNames.has('uid_validity')) {
    db.exec('ALTER TABLE folders ADD COLUMN uid_validity INTEGER')
  }
  if (!folderNames.has('highest_synced_uid')) {
    db.exec('ALTER TABLE folders ADD COLUMN highest_synced_uid INTEGER NOT NULL DEFAULT 0')
  }
  if (!folderNames.has('last_sync_at')) {
    db.exec('ALTER TABLE folders ADD COLUMN last_sync_at INTEGER')
  }
  if (!folderNames.has('initial_sync_complete')) {
    db.exec('ALTER TABLE folders ADD COLUMN initial_sync_complete INTEGER NOT NULL DEFAULT 0')
  }
  if (!folderNames.has('highest_modseq')) {
    db.exec('ALTER TABLE folders ADD COLUMN highest_modseq TEXT')
  }
  if (!folderNames.has('server_message_count')) {
    db.exec('ALTER TABLE folders ADD COLUMN server_message_count INTEGER')
  }
  if (!folderNames.has('is_virtual_view')) {
    db.exec('ALTER TABLE folders ADD COLUMN is_virtual_view INTEGER NOT NULL DEFAULT 0')
    db.exec(`
      UPDATE folders
      SET is_virtual_view = 1
      WHERE imap_path IN (
        '[Gmail]/All Mail',
        '[Gmail]/Important',
        '[Gmail]/Starred',
        '[Gmail]/Snoozed'
      )
      AND account_id IN (SELECT id FROM accounts WHERE provider = 'gmail')
    `)
  }

  // The UNIQUE(folder_id, uid) index postdates the MVP, which inserted a fresh
  // row per sync and so could accumulate duplicate (folder_id, uid) rows. On such
  // a database `CREATE UNIQUE INDEX` fails with "UNIQUE constraint failed", and
  // because this runs at startup the whole app fails to launch — every launch,
  // with no in-app recovery. Remove the duplicates first so the index can build.
  dedupeMessagesByFolderUid(db)
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS messages_folder_uid_idx ON messages(folder_id, uid)'
  )

  // Partial index over just the unread rows — speeds the unread recount that runs
  // after every read/delete and the mark-all-read scan.
  db.exec(
    'CREATE INDEX IF NOT EXISTS messages_folder_unread_idx ON messages(folder_id) WHERE is_read = 0'
  )

  db.exec(`
    UPDATE folders
    SET highest_synced_uid = (
      SELECT COALESCE(MAX(uid), 0) FROM messages WHERE messages.folder_id = folders.id
    )
    WHERE highest_synced_uid = 0
      AND EXISTS (SELECT 1 FROM messages WHERE messages.folder_id = folders.id)
  `)

  db.exec(`
    UPDATE folders
    SET initial_sync_complete = 1
    WHERE highest_synced_uid > 0
  `)

  const messageCols = db.prepare('PRAGMA table_info(messages)').all() as Array<{ name: string }>
  const messageNames = new Set(messageCols.map((c) => c.name))
  if (!messageNames.has('flag_color')) {
    db.exec('ALTER TABLE messages ADD COLUMN flag_color TEXT')
  }
  if (!messageNames.has('ai_analysis')) {
    db.exec('ALTER TABLE messages ADD COLUMN ai_analysis TEXT')
  }
  if (!messageNames.has('ai_analysis_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN ai_analysis_at INTEGER')
  }
  if (!messageNames.has('sweep_cache')) {
    db.exec('ALTER TABLE messages ADD COLUMN sweep_cache TEXT')
  }
  if (!messageNames.has('sweep_cache_at')) {
    db.exec('ALTER TABLE messages ADD COLUMN sweep_cache_at INTEGER')
  }
  if (!messageNames.has('in_reply_to')) {
    db.exec('ALTER TABLE messages ADD COLUMN in_reply_to TEXT')
  }
  if (!messageNames.has('references')) {
    db.exec('ALTER TABLE messages ADD COLUMN "references" TEXT')
  }
  if (!messageNames.has('thread_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT')
  }
  if (!messageNames.has('search_text')) {
    db.exec('ALTER TABLE messages ADD COLUMN search_text TEXT')
  }
  if (!messageNames.has('server_uid')) {
    db.exec('ALTER TABLE messages ADD COLUMN server_uid TEXT')
  }

  // These depend on the thread_id column above existing, so they must run after
  // the ALTER (on an upgraded DB the column is only just added here).
  db.exec('CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(account_id, thread_id)')
  db.exec('CREATE INDEX IF NOT EXISTS messages_message_id_idx ON messages(message_id)')
  backfillThreadIds(db)
  pruneOrphanedSweepTasks(db)

  const accountCols = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>
  const accountNames = new Set(accountCols.map((c) => c.name))
  if (!accountNames.has('sync_days')) {
    db.exec('ALTER TABLE accounts ADD COLUMN sync_days INTEGER NOT NULL DEFAULT 90')
  }

  const sweepTaskCols = db.prepare('PRAGMA table_info(sweep_tasks)').all() as Array<{ name: string }>
  const sweepTaskNames = new Set(sweepTaskCols.map((c) => c.name))
  if (!sweepTaskNames.has('source')) {
    db.exec("ALTER TABLE sweep_tasks ADD COLUMN source TEXT NOT NULL DEFAULT 'sweep'")
  }

  // Thread listing indexes. Threads are keyed by COALESCE(thread_id, id) — a
  // message with no derived thread is its own thread — and no plain column
  // index can serve that expression, so listThreads/countThreads were scanning
  // the account and building temp b-trees for DISTINCT, GROUP BY and ORDER BY
  // on every folder switch (twice: once to list, once to count).
  //
  //  - thread_key_date: groups a conversation's messages together in date
  //    order, so MAX(date) per thread comes off the index.
  //  - folder_thread_key: covering index for "which conversations have a
  //    message in this folder", which is the whole of countThreads. account_id
  //    must precede the expression for the DISTINCT over (account_id, key) to
  //    be satisfied by an ordered index scan; is_read rides along for the
  //    unread-only variant.
  //
  // Measured on a real 3.3k-message, 1140-thread profile, for ~0.9MB of index:
  //   listThreads   57.7ms -> 35.4ms   (warm page cache, via db-service)
  //   countThreads   3.9ms ->  1.0ms
  //   heads query  119.4ms -> 38.5ms   (cold page cache, raw SQL)
  // Cold is what a folder switch shortly after launch pays. The gain does not
  // depend on ANALYZE having run, which this app never does.
  db.exec(
    'CREATE INDEX IF NOT EXISTS messages_thread_key_date_idx ON messages(account_id, COALESCE(thread_id, id), date)'
  )
  db.exec(
    'CREATE INDEX IF NOT EXISTS messages_folder_thread_key_idx ON messages(folder_id, account_id, COALESCE(thread_id, id), is_read)'
  )

  // Attachments are only ever looked up by message_id, and the ON DELETE CASCADE
  // from messages walks the same key. Without this index every message open is a
  // full scan of attachments, and deleting messages is one full scan *per row* —
  // pruning a folder of N messages did N scans of the whole table.
  db.exec('CREATE INDEX IF NOT EXISTS attachments_message_id_idx ON attachments(message_id)')

  // Drop the old full-text index. It was written on every synced message and
  // never read — the search path has always used LIKE — and its deletes could
  // not work, because a contentless FTS5 table reads every column back as NULL
  // and so can never match `WHERE message_id = ?`. It therefore accumulated a
  // duplicate row per re-index, forever. Dropping it removes ~0.5ms per message
  // from sync and frees its pages (7.7MB on a 3.3k-message profile); the file
  // itself only shrinks on a VACUUM, which this app does not run.
  db.exec('DROP TABLE IF EXISTS messages_fts')
  db.prepare("DELETE FROM app_preferences WHERE key = 'fts_index_v2'").run()

  // Per-account signature. Appended, never reordered — see the note above.
  // `accountNames` was read at the top of this function, before any of the
  // ALTERs below it, so it is still an accurate picture of the pre-migration
  // columns.
  if (!accountNames.has('signature')) {
    db.exec('ALTER TABLE accounts ADD COLUMN signature TEXT')
  }

  // Out-of-window POP3 messages, remembered by UIDL so each poll does not read
  // their headers again. A CREATE for an existing database; `initTables` makes it
  // for a fresh one.
  db.exec(`
    CREATE TABLE IF NOT EXISTS pop3_skipped (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      server_uid TEXT NOT NULL,
      message_date INTEGER NOT NULL,
      PRIMARY KEY (account_id, server_uid)
    )
  `)

  // Cached conversation summaries. Same shape as above: a CREATE for an existing
  // database, with `initTables` covering a fresh one.
  db.exec(`
    CREATE TABLE IF NOT EXISTS thread_analysis (
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      json TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      analyzed_count INTEGER NOT NULL,
      latest_message_id TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id)
    )
  `)

  // Inline-image marking. Appended, never reordered — see the note above.
  const attachmentCols = db.prepare('PRAGMA table_info(attachments)').all() as Array<{
    name: string
  }>
  if (!new Set(attachmentCols.map((c) => c.name)).has('is_inline')) {
    db.exec('ALTER TABLE attachments ADD COLUMN is_inline INTEGER NOT NULL DEFAULT 0')
  }
  backfillInlineAttachments(db)

  // Work the app owes the future: held sends, timed sends, snoozed messages.
  // CREATE TABLE IF NOT EXISTS is idempotent, so this is safe to run on every
  // start alongside the ALTER steps above.
  db.exec(`
    CREATE TABLE IF NOT EXISTS scheduled_actions (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_actions_due_idx ON scheduled_actions(due_at);
  `)
}

// Decoded byte length of a base64 payload of `length` characters, `padding` of
// which are trailing '='. Every 4 characters carry 3 bytes.
function base64DecodedLength(length: number, padding: number): number {
  return (length / 4) * 3 - padding
}

// Header plus payload in one match, so the scan stays inside the regex engine.
// Walking the payload character by character from JS instead cost 14s over the
// 313MB of message bodies on a real profile; this is ~1s.
const EMBEDDED_IMAGE = /data:(image\/[\w+.-]+);base64,([A-Za-z0-9+/=]+)/gi

/**
 * The `mime:size` of every `data:` image already embedded in an HTML body.
 *
 * The payload is matched by what base64 may contain rather than by looking for
 * the quote that closes the `src`, because the body is not trusted to be
 * well-formed. Only its *length* is read — the decoded size follows from that
 * and the padding, so nothing has to be decoded.
 */
function embeddedImageSizes(html: string): Set<string> {
  const sizes = new Set<string>()
  EMBEDDED_IMAGE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = EMBEDDED_IMAGE.exec(html)) !== null) {
    const payload = match[2]
    if (payload.length % 4 !== 0) continue
    let padding = 0
    while (padding < 2 && payload[payload.length - 1 - padding] === '=') padding++
    sizes.add(`${match[1].toLowerCase()}:${base64DecodedLength(payload.length, padding)}`)
  }
  return sizes
}

/**
 * One-time: mark the inline images already synced, so history stops showing a
 * signature logo per reply as an attachment.
 *
 * The flag is normally set at parse time from mailparser's `related`/`cid`,
 * which are long gone for a stored row — but the evidence survives in the body.
 * mailparser rewrites each referenced `cid:` into a `data:` URI, so an image row
 * whose MIME and decoded size match one of the body's embedded images is one of
 * those rewrites.
 *
 * Matches are *not* consumed, and that is deliberate: the parts outnumber the
 * embedded copies. One real message here holds 140 image parts against 70
 * `data:` URIs — Outlook kept a part per quoted reply while the body embeds each
 * distinct image once, and mailparser's rewrite is keyed by cid, so the surplus
 * has no body evidence of its own. Flagging every row that matches a size which
 * *is* embedded catches those; consuming one match per URI would leave half the
 * chips behind, which is the complaint.
 *
 * The cost is a real attachment that is byte-for-byte the same size and type as
 * an embedded image on the same message, which would be collapsed with them.
 * That is why the reader discloses what it hid instead of deleting rows, and why
 * this is scoped to `image/*` on messages that actually embed data: URIs.
 * Guarded so it runs once.
 */
export function backfillInlineAttachments(db: Database.Database): number {
  const done = db
    .prepare("SELECT value FROM app_preferences WHERE key = 'inline_attachment_backfill_v1'")
    .get() as { value: string } | undefined
  if (done?.value === '1') return 0

  // Driven from attachments, which is indexed and small. Adding the obvious
  // `AND m.body_html LIKE '%data:image%'` here reads instead like a scan of
  // every body in the database — 0.5s for a filter the loop below applies for
  // free when it fetches the body it needs anyway.
  const candidates = db
    .prepare(
      `SELECT DISTINCT message_id AS id
       FROM attachments
       WHERE mime_type LIKE 'image/%' AND is_inline = 0`
    )
    .all() as Array<{ id: string }>

  const readBody = db.prepare('SELECT body_html FROM messages WHERE id = ?')
  const readRows = db.prepare(
    "SELECT id, mime_type, size FROM attachments WHERE message_id = ? AND mime_type LIKE 'image/%'"
  )
  const markInline = db.prepare('UPDATE attachments SET is_inline = 1 WHERE id = ?')

  let flagged = 0
  let touched = 0
  const run = db.transaction((ids: Array<{ id: string }>) => {
    for (const { id } of ids) {
      const body = readBody.get(id) as { body_html: string | null } | undefined
      if (!body?.body_html) continue
      const sizes = embeddedImageSizes(body.body_html)
      if (sizes.size === 0) continue

      const rows = readRows.all(id) as Array<{ id: string; mime_type: string; size: number }>
      for (const row of rows) {
        if (!sizes.has(`${row.mime_type.toLowerCase()}:${row.size}`)) continue
        markInline.run(row.id)
        flagged++
      }
      touched++
    }

    // The list-pane paperclip reads has_attachments, so a message left with
    // nothing but inline images has to stop claiming one.
    db.prepare(
      `UPDATE messages SET has_attachments = 0
       WHERE has_attachments = 1
         AND NOT EXISTS (
           SELECT 1 FROM attachments WHERE message_id = messages.id AND is_inline = 0
         )`
    ).run()
  })
  run(candidates)

  if (flagged > 0) {
    console.log(
      `[orbit-mail] Marked ${flagged} embedded image(s) across ${touched} message(s) as inline.`
    )
  }

  db.prepare(
    "INSERT INTO app_preferences (key, value) VALUES ('inline_attachment_backfill_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run()
  return flagged
}

// Remove duplicate (folder_id, uid) message rows so the UNIQUE index can be
// built (see its caller). Duplicates are the same server message copied by the
// pre-constraint upsert path, so collapsing them to one row is correct. The
// survivor is chosen to preserve the most work: a row that already carries AI
// analysis or a sweep cache is kept over one that does not, then the most
// recently written (highest rowid). Attachments of dropped rows go with them via
// ON DELETE CASCADE. Returns the number of rows removed (0 on a healthy DB, so
// this is a cheap no-op on every normal launch). Exported for the suite.
export function dedupeMessagesByFolderUid(db: Database.Database): number {
  const dupeGroups = db
    .prepare(
      'SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages GROUP BY folder_id, uid HAVING COUNT(*) > 1)'
    )
    .get() as { n: number }
  if (dupeGroups.n === 0) return 0

  const removed = db
    .prepare(
      `DELETE FROM messages WHERE rowid IN (
         SELECT rowid FROM (
           SELECT rowid, ROW_NUMBER() OVER (
             PARTITION BY folder_id, uid
             ORDER BY (ai_analysis IS NOT NULL) DESC,
                      (sweep_cache IS NOT NULL) DESC,
                      rowid DESC
           ) AS rn
           FROM messages
         ) WHERE rn > 1
       )`
    )
    .run().changes

  console.warn(
    `[db] removed ${removed} duplicate (folder_id, uid) message row(s) before building the unique index`
  )
  return removed
}

// One-time: give already-synced messages a thread_id. They predate the stored
// threading headers, so group them by normalized subject; mail synced from here
// on gets a header-derived id in the sync path. Guarded so it runs once.
function backfillThreadIds(db: Database.Database): void {
  const done = db
    .prepare("SELECT value FROM app_preferences WHERE key = 'thread_backfill_v1'")
    .get() as { value: string } | undefined
  if (done?.value === '1') return

  const rows = db
    .prepare('SELECT id, subject FROM messages WHERE thread_id IS NULL')
    .all() as Array<{ id: string; subject: string }>

  if (rows.length > 0) {
    const update = db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
    const run = db.transaction((items: Array<{ id: string; subject: string }>) => {
      for (const r of items) {
        update.run(`subj:${normalizeSubject(r.subject)}`, r.id)
      }
    })
    run(rows)
  }

  db.prepare(
    "INSERT INTO app_preferences (key, value) VALUES ('thread_backfill_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run()
}

// One-time: remove AI Tasks (sweep_tasks) orphaned by account deletions that
// predate the per-account cleanup in removeAccount. sweep_tasks has no foreign
// key, so those deletions cascaded the account's folders and messages away but
// left the task rows behind, invisible in the UI (their folder is gone) yet
// still holding mail-derived content.
//
// Scoped to the unambiguous signature: a *per-folder* task whose folder no
// longer exists. Folders vanish only via the account cascade — there is no
// folder-delete path — so a missing folder means the account was removed.
//
// Deliberately NOT swept: unified-inbox tasks (folder_id 'unified') whose source
// message is missing. A message goes missing both when its account is deleted
// AND when it ages out of the local sync window, and the two are
// indistinguishable after the fact — so removing those would risk deleting a
// still-valid todo whose email merely left the cache. removeAccount handles the
// unified case correctly going forward, while the message still exists.
export function pruneOrphanedSweepTasks(db: Database.Database): void {
  const done = db
    .prepare("SELECT value FROM app_preferences WHERE key = 'sweep_task_orphan_cleanup_v1'")
    .get() as { value: string } | undefined
  if (done?.value === '1') return

  const info = db
    .prepare(
      `DELETE FROM sweep_tasks
       WHERE folder_id <> 'unified'
         AND folder_id NOT IN (SELECT id FROM folders)`
    )
    .run()
  if (info.changes > 0) {
    console.log(`[orbit-mail] Removed ${info.changes} orphaned AI task(s) from deleted accounts.`)
  }

  db.prepare(
    "INSERT INTO app_preferences (key, value) VALUES ('sweep_task_orphan_cleanup_v1', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run()
}

// Whether a full VACUUM is worth its cost — a whole-file rewrite that blocks the
// connection and briefly needs free disk roughly equal to the database size.
// Only when a large fraction of the file is free pages *and* there is a
// meaningful amount to reclaim; vacuuming a small database churns disk for
// nothing. Pure so it can be tested without a bloated database.
export function shouldReclaimFreelist(
  pageCount: number,
  freelistCount: number,
  pageSize: number
): boolean {
  if (pageCount <= 0) return false
  const freeBytes = freelistCount * pageSize
  return freelistCount / pageCount >= 0.25 && freeBytes >= 20 * 1024 * 1024
}

// Reclaim freelist space with VACUUM when it has grown large. Returns the bytes
// reclaimed, or 0 if skipped. VACUUM is synchronous and blocks the connection
// for the rewrite (~2s on a 300MB database), so the caller runs this only at a
// quiet moment — on quit, after the window has closed — never during
// interactive use or before first paint. Self-throttling: VACUUM zeroes the
// freelist, so it does not run again until enough mail has been deleted to
// rebuild it.
export function reclaimFreelistIfLarge(): number {
  const db = getRawSqlite()
  const pageCount = db.pragma('page_count', { simple: true }) as number
  const freelistCount = db.pragma('freelist_count', { simple: true }) as number
  const pageSize = db.pragma('page_size', { simple: true }) as number
  if (!shouldReclaimFreelist(pageCount, freelistCount, pageSize)) return 0
  db.exec('VACUUM')
  return freelistCount * pageSize
}

export function getDb() {
  if (!dbInstance) {
    const dbPath = join(getDataDir(), 'orbit-mail.db')
    sqliteInstance = new Database(dbPath)
    sqliteInstance.pragma('journal_mode = WAL')
    // After WAL is on, so the -wal and -shm sidecars exist to be restricted.
    restrictDatabaseFiles(dbPath)
    restrictDataDirectories()
    sqliteInstance.pragma('foreign_keys = ON')
    // Performance pragmas. Safe under WAL: NORMAL synchronous keeps durability
    // for committed transactions while skipping fsync on every write; the cache,
    // memory-mapped I/O, and in-memory temp store cut read latency; the busy
    // timeout avoids spurious SQLITE_BUSY under the IDLE/poll/UI write mix.
    sqliteInstance.pragma('synchronous = NORMAL')
    sqliteInstance.pragma('cache_size = -16000') // ~16 MB page cache
    sqliteInstance.pragma('temp_store = MEMORY')
    sqliteInstance.pragma('mmap_size = 268435456') // 256 MB
    sqliteInstance.pragma('busy_timeout = 5000')
    initTables(sqliteInstance)
    dbInstance = drizzle(sqliteInstance, { schema })
  }
  return dbInstance
}

export function getRawSqlite(): Database.Database {
  getDb()
  return sqliteInstance!
}

