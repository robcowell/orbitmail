import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { normalizeSubject } from '../services/thread-util'

let dbInstance: ReturnType<typeof drizzle<typeof schema>> | null = null
let sqliteInstance: Database.Database | null = null

export function getDataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function getAttachmentsDir(): string {
  const dir = join(getDataDir(), 'attachments')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
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
      sync_days INTEGER NOT NULL DEFAULT 90
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
      ai_analysis TEXT,
      ai_analysis_at INTEGER,
      sweep_cache TEXT,
      sweep_cache_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS messages_folder_date_idx ON messages(folder_id, date);
    CREATE INDEX IF NOT EXISTS messages_account_date_idx ON messages(account_id, date);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      local_path TEXT
    );

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

  // Drop the old full-text index. It was written on every synced message and
  // never read — the search path has always used LIKE — and its deletes could
  // not work, because a contentless FTS5 table reads every column back as NULL
  // and so can never match `WHERE message_id = ?`. It therefore accumulated a
  // duplicate row per re-index, forever. Dropping it removes ~0.5ms per message
  // from sync and frees its pages (7.7MB on a 3.3k-message profile); the file
  // itself only shrinks on a VACUUM, which this app does not run.
  db.exec('DROP TABLE IF EXISTS messages_fts')
  db.prepare("DELETE FROM app_preferences WHERE key = 'fts_index_v2'").run()
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

export function getDb() {
  if (!dbInstance) {
    const dbPath = join(getDataDir(), 'orbit-mail.db')
    sqliteInstance = new Database(dbPath)
    sqliteInstance.pragma('journal_mode = WAL')
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

