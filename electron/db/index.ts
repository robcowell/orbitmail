import { app } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { indexMessageInFts, migrateFtsIndex } from '../services/search-index'

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

function initFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      subject,
      snippet,
      body_text,
      content='',
      contentless_delete=1
    );
  `)
}

function initTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT NOT NULL,
      display_name TEXT NOT NULL,
      token_blob TEXT NOT NULL,
      created_at INTEGER NOT NULL
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
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      cc TEXT,
      subject TEXT NOT NULL,
      snippet TEXT NOT NULL,
      date INTEGER NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
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

  const accountCols = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>
  const accountNames = new Set(accountCols.map((c) => c.name))
  if (!accountNames.has('sync_days')) {
    db.exec('ALTER TABLE accounts ADD COLUMN sync_days INTEGER NOT NULL DEFAULT 90')
  }
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
    initFts(sqliteInstance)
    migrateFtsIndex(sqliteInstance)
    dbInstance = drizzle(sqliteInstance, { schema })
  }
  return dbInstance
}

export function getRawSqlite(): Database.Database {
  getDb()
  return sqliteInstance!
}

export function upsertFts(
  messageId: string,
  subject: string,
  snippet: string,
  bodyText?: string | null,
  bodyHtml?: string | null
): void {
  indexMessageInFts(getRawSqlite(), messageId, subject, snippet, bodyText, bodyHtml)
}

export function deleteFts(messageId: string): void {
  getRawSqlite().prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId)
}
