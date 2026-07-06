import { randomUUID } from 'crypto'
import { existsSync, statSync, unlinkSync } from 'fs'
import { eq, desc, and, inArray, max, count, lt, sql } from 'drizzle-orm'
import { getDb, getRawSqlite, upsertFts, deleteFts } from '../db'
import { accounts, folders, messages, attachments, sweepTasks } from '../db/schema'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  ThreadSummary,
  FolderType,
  Provider,
  FlagColor,
  SweepScope,
  SweepTask,
  CompletedTask
} from '../../shared/types'
import {
  encryptCredentials,
  decryptCredentials,
  type TokenData,
  type ManualAccountCredentials,
  type AccountCredentials
} from './account-credentials'
import { DEFAULT_SYNC_DAYS, getSyncCutoffTimestamp } from './sync-policy'
import { buildFtsQuery, buildLikePattern } from './search-index'

export type { TokenData, ManualAccountCredentials, AccountCredentials }

export function saveAccount(
  provider: Provider,
  tokenData: TokenData
): Account {
  const db = getDb()
  const existing = db
    .select()
    .from(accounts)
    .where(eq(accounts.email, tokenData.email))
    .get()

  if (existing) {
    db.update(accounts)
      .set({
        provider,
        displayName: tokenData.displayName,
        tokenBlob: encryptCredentials({ authType: 'oauth', ...tokenData })
      })
      .where(eq(accounts.id, existing.id))
      .run()
    return {
      id: existing.id,
      provider,
      email: tokenData.email,
      displayName: tokenData.displayName,
      syncDays: existing.syncDays
    }
  }

  const id = randomUUID()
  const account: Account = {
    id,
    provider,
    email: tokenData.email,
    displayName: tokenData.displayName,
    syncDays: DEFAULT_SYNC_DAYS
  }
  db.insert(accounts).values({
    id,
    provider,
    email: tokenData.email,
    displayName: tokenData.displayName,
    tokenBlob: encryptCredentials({ authType: 'oauth', ...tokenData }),
    createdAt: Date.now(),
    syncDays: DEFAULT_SYNC_DAYS
  }).run()
  return account
}

export function saveManualAccount(
  provider: 'imap' | 'pop3',
  creds: ManualAccountCredentials
): Account {
  const db = getDb()
  const existing = db
    .select()
    .from(accounts)
    .where(eq(accounts.email, creds.email))
    .get()

  if (existing) {
    db.update(accounts)
      .set({
        provider,
        displayName: creds.displayName,
        tokenBlob: encryptCredentials(creds)
      })
      .where(eq(accounts.id, existing.id))
      .run()
    return {
      id: existing.id,
      provider,
      email: creds.email,
      displayName: creds.displayName,
      syncDays: existing.syncDays
    }
  }

  const id = randomUUID()
  db.insert(accounts).values({
    id,
    provider,
    email: creds.email,
    displayName: creds.displayName,
    tokenBlob: encryptCredentials(creds),
    createdAt: Date.now(),
    syncDays: DEFAULT_SYNC_DAYS
  }).run()

  return {
    id,
    provider,
    email: creds.email,
    displayName: creds.displayName,
    syncDays: DEFAULT_SYNC_DAYS
  }
}

export function getAccountCredentials(accountId: string): AccountCredentials | null {
  const db = getDb()
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!row) return null
  return decryptCredentials(row.tokenBlob)
}

export function getAccountTokens(accountId: string): TokenData | null {
  const creds = getAccountCredentials(accountId)
  if (!creds || creds.authType !== 'oauth') return null
  return creds
}

export function getManualCredentials(accountId: string): ManualAccountCredentials | null {
  const creds = getAccountCredentials(accountId)
  if (!creds || creds.authType !== 'password') return null
  return creds
}

export function updateAccountTokens(accountId: string, tokenData: TokenData): void {
  const db = getDb()
  db.update(accounts)
    .set({ tokenBlob: encryptCredentials({ authType: 'oauth', ...tokenData }) })
    .where(eq(accounts.id, accountId))
    .run()
}

export function listAccounts(): Account[] {
  const db = getDb()
  return db.select().from(accounts).all().map((r) => ({
    id: r.id,
    provider: r.provider as Provider,
    email: r.email,
    displayName: r.displayName,
    syncDays: r.syncDays
  }))
}

export function getAccountById(accountId: string): (Account & { createdAt: number }) | null {
  const db = getDb()
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider as Provider,
    email: row.email,
    displayName: row.displayName,
    syncDays: row.syncDays,
    createdAt: row.createdAt
  }
}

export function getAccountSyncDays(accountId: string): number {
  const db = getDb()
  const row = db
    .select({ syncDays: accounts.syncDays })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()
  return row?.syncDays ?? DEFAULT_SYNC_DAYS
}

export function updateAccountSyncDays(accountId: string, syncDays: number): Account {
  const db = getDb()
  const normalized = syncDays <= 0 ? 0 : Math.max(1, Math.round(syncDays))
  db.update(accounts).set({ syncDays: normalized }).where(eq(accounts.id, accountId)).run()
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!row) throw new Error('Account not found')
  return {
    id: row.id,
    provider: row.provider as Provider,
    email: row.email,
    displayName: row.displayName,
    syncDays: row.syncDays
  }
}

export function updateAccountDisplayName(accountId: string, displayName: string): Account {
  const db = getDb()
  db.update(accounts).set({ displayName }).where(eq(accounts.id, accountId)).run()
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!row) throw new Error('Account not found')
  return {
    id: row.id,
    provider: row.provider as Provider,
    email: row.email,
    displayName: row.displayName,
    syncDays: row.syncDays
  }
}

export function getMessageSyncContext(messageId: string): {
  accountId: string
  folderId: string
  uid: number
  provider: Provider
} | null {
  const db = getDb()
  const message = db
    .select({
      accountId: messages.accountId,
      folderId: messages.folderId,
      uid: messages.uid
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!message) return null

  const account = db
    .select({ provider: accounts.provider })
    .from(accounts)
    .where(eq(accounts.id, message.accountId))
    .get()
  if (!account) return null

  return {
    accountId: message.accountId,
    folderId: message.folderId,
    uid: message.uid,
    provider: account.provider as Provider
  }
}

export function markAllMessagesReadInFolder(folderId: string): number {
  const db = getDb()
  const unread = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.folderId, folderId), eq(messages.isRead, false)))
    .all()

  if (unread.length === 0) {
    recalculateFolderUnread(folderId)
    return 0
  }

  db.update(messages)
    .set({ isRead: true })
    .where(and(eq(messages.folderId, folderId), eq(messages.isRead, false)))
    .run()
  recalculateFolderUnread(folderId)
  return unread.length
}

export function removeAccount(accountId: string): void {
  const sqlite = getRawSqlite()
  const paths = sqlite
    .prepare(
      `SELECT a.local_path
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.account_id = ? AND a.local_path IS NOT NULL`
    )
    .all(accountId) as Array<{ local_path: string }>

  for (const row of paths) {
    try {
      if (existsSync(row.local_path)) unlinkSync(row.local_path)
    } catch {
      // ignore missing files
    }
  }

  const db = getDb()
  db.delete(accounts).where(eq(accounts.id, accountId)).run()
}

export function upsertFolder(
  accountId: string,
  imapPath: string,
  name: string,
  type: FolderType,
  isVirtualView = false
): Folder {
  const db = getDb()
  const existing = db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.imapPath, imapPath)))
    .get()

  if (existing) {
    if (existing.isVirtualView !== isVirtualView) {
      db.update(folders).set({ isVirtualView }).where(eq(folders.id, existing.id)).run()
    }
    return {
      id: existing.id,
      accountId: existing.accountId,
      imapPath: existing.imapPath,
      name: existing.name,
      type: existing.type as FolderType,
      unreadCount: existing.unreadCount,
      isVirtualView
    }
  }

  const id = randomUUID()
  db.insert(folders).values({
    id,
    accountId,
    imapPath,
    name,
    type,
    unreadCount: 0,
    isVirtualView
  }).run()

  return { id, accountId, imapPath, name, type, unreadCount: 0, isVirtualView }
}

export function listFolders(accountId?: string): Folder[] {
  const db = getDb()
  const rows = accountId
    ? db.select().from(folders).where(eq(folders.accountId, accountId)).all()
    : db.select().from(folders).all()
  return rows.map((r) => ({
    id: r.id,
    accountId: r.accountId,
    imapPath: r.imapPath,
    name: r.name,
    type: r.type as FolderType,
    unreadCount: r.unreadCount,
    isVirtualView: r.isVirtualView
  }))
}

export function getFolderById(folderId: string): Folder | null {
  const db = getDb()
  const r = db.select().from(folders).where(eq(folders.id, folderId)).get()
  if (!r) return null
  return {
    id: r.id,
    accountId: r.accountId,
    imapPath: r.imapPath,
    name: r.name,
    type: r.type as FolderType,
    unreadCount: r.unreadCount,
    isVirtualView: r.isVirtualView
  }
}

export function getInboxFolderIds(): string[] {
  const db = getDb()
  return db.select({ id: folders.id }).from(folders).where(eq(folders.type, 'inbox')).all().map((r) => r.id)
}

export interface LatestInboxMessage {
  accountLabel: string
  from: string
  subject: string
}

// The most recent inbox message across all accounts — used to describe the
// just-arrived mail in a desktop notification (account, sender, subject).
export function getLatestInboxMessage(): LatestInboxMessage | null {
  const db = getDb()
  const inboxIds = getInboxFolderIds()
  if (inboxIds.length === 0) return null

  const row = db
    .select({ from: messages.from, subject: messages.subject, accountId: messages.accountId })
    .from(messages)
    .where(inArray(messages.folderId, inboxIds))
    .orderBy(desc(messages.date))
    .limit(1)
    .get()
  if (!row) return null

  const account = db.select().from(accounts).where(eq(accounts.id, row.accountId)).get()
  return {
    accountLabel: account?.email || account?.displayName || 'Orbit Mail',
    from: row.from,
    subject: row.subject
  }
}

// Just the columns a MessageSummary needs — avoids reading the (potentially
// large) body_html/body_text blobs when only rendering the list.
const SUMMARY_COLS = {
  id: messages.id,
  folderId: messages.folderId,
  accountId: messages.accountId,
  uid: messages.uid,
  messageId: messages.messageId,
  from: messages.from,
  to: messages.to,
  subject: messages.subject,
  snippet: messages.snippet,
  date: messages.date,
  isRead: messages.isRead,
  isStarred: messages.isStarred,
  flagColor: messages.flagColor,
  hasAttachments: messages.hasAttachments,
  threadId: messages.threadId
} as const

type SummaryRow = {
  id: string
  folderId: string
  accountId: string
  uid: number
  messageId: string | null
  from: string
  to: string
  subject: string
  snippet: string
  date: number
  isRead: boolean
  isStarred: boolean
  flagColor: string | null
  hasAttachments: boolean
  threadId: string | null
}

function rowToSummary(r: SummaryRow): MessageSummary {
  return {
    id: r.id,
    folderId: r.folderId,
    accountId: r.accountId,
    uid: r.uid,
    messageId: r.messageId,
    from: r.from,
    to: r.to,
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    isRead: r.isRead,
    isStarred: r.isStarred,
    flagColor: (r.flagColor as FlagColor | null) ?? null,
    hasAttachments: r.hasAttachments,
    threadId: r.threadId
  }
}

export function listMessages(
  folderId: string | 'unified',
  limit = 200,
  offset = 0
): MessageSummary[] {
  const db = getDb()
  let rows: SummaryRow[]

  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return []
    rows = db
      .select(SUMMARY_COLS)
      .from(messages)
      .where(inArray(messages.folderId, inboxIds))
      .orderBy(desc(messages.date))
      .limit(limit)
      .offset(offset)
      .all()
  } else {
    rows = db
      .select(SUMMARY_COLS)
      .from(messages)
      .where(eq(messages.folderId, folderId))
      .orderBy(desc(messages.date))
      .limit(limit)
      .offset(offset)
      .all()
  }

  return rows.map(rowToSummary)
}

// ---------------------------------------------------------------------------
// Conversation threading. The list groups the current folder's messages into
// threads (one row per conversation); opening a thread pulls the full
// conversation across folders (getThread). Grouping key is COALESCE(thread_id,
// id) scoped per account, so a message without a thread_id is its own thread and
// subject-fallback keys never merge across accounts.
// ---------------------------------------------------------------------------

function extractName(from: string): string {
  const match = from.match(/^(.+?)\s*</)
  if (match) return match[1].replace(/"/g, '').trim()
  return from
}

// Folder ids the current view scopes to (unified = every inbox). Empty = nothing.
function threadScopeIds(folderId: string | 'unified'): string[] {
  return folderId === 'unified' ? getInboxFolderIds() : [folderId]
}

interface ThreadMsgRow {
  id: string
  aid: string
  tkey: string
  mkey: string
  folder_id: string
  from_addr: string
  subject: string
  snippet: string
  date: number
  is_read: number
  is_starred: number
  flag_color: string | null
  has_attachments: number
}

// A thread is grouped account-wide across folders and **deduplicated by
// Message-ID** — Gmail exposes each label as an IMAP folder, so one email is
// stored once per label and would otherwise be counted/shown multiple times.
export function listThreads(
  folderId: string | 'unified',
  limit = 200,
  offset = 0
): ThreadSummary[] {
  const scopeIds = threadScopeIds(folderId)
  if (scopeIds.length === 0) return []
  const scope = new Set(scopeIds)
  const sqlite = getRawSqlite()
  const ph = scopeIds.map(() => '?').join(', ')

  // Page of thread keys with a message in this folder, ordered by the
  // conversation's most recent message (account-wide — a Sent reply counts).
  const heads = sqlite
    .prepare(
      `SELECT aid, tkey, MAX(date) AS last_date
       FROM (
         SELECT account_id AS aid, COALESCE(thread_id, id) AS tkey, date
         FROM messages
         WHERE (account_id, COALESCE(thread_id, id)) IN (
           SELECT DISTINCT account_id, COALESCE(thread_id, id)
           FROM messages WHERE folder_id IN (${ph})
         )
       )
       GROUP BY aid, tkey
       ORDER BY last_date DESC
       LIMIT ? OFFSET ?`
    )
    .all(...scopeIds, limit, offset) as Array<{ aid: string; tkey: string; last_date: number }>
  if (heads.length === 0) return []

  // Every message in those conversations (across folders), lightweight columns.
  const pairs = heads.map(() => '(?, ?)').join(', ')
  const pairArgs: unknown[] = []
  for (const h of heads) pairArgs.push(h.aid, h.tkey)
  const rows = sqlite
    .prepare(
      `SELECT id, account_id AS aid, COALESCE(thread_id, id) AS tkey, COALESCE(message_id, id) AS mkey,
              folder_id, from_addr, subject, snippet, date, is_read, is_starred, flag_color, has_attachments
       FROM messages
       WHERE (account_id, COALESCE(thread_id, id)) IN (VALUES ${pairs})
       ORDER BY date ASC`
    )
    .all(...pairArgs) as ThreadMsgRow[]

  interface Group {
    all: ThreadMsgRow[]
    unique: ThreadMsgRow[]
    seen: Set<string>
  }
  const groups = new Map<string, Group>()
  for (const r of rows) {
    const key = `${r.aid} ${r.tkey}`
    let g = groups.get(key)
    if (!g) {
      g = { all: [], unique: [], seen: new Set() }
      groups.set(key, g)
    }
    g.all.push(r)
    if (!g.seen.has(r.mkey)) {
      g.seen.add(r.mkey)
      g.unique.push(r)
    }
  }

  return heads.map((h) => {
    const g = groups.get(`${h.aid} ${h.tkey}`)
    const unique = g?.unique ?? []
    const all = g?.all ?? []
    const latest = unique[unique.length - 1]
    const participants: string[] = []
    for (const m of unique) {
      const name = extractName(m.from_addr)
      if (!participants.includes(name)) participants.push(name)
    }
    const flagged = unique.find((m) => m.flag_color)
    return {
      threadId: h.tkey,
      accountId: h.aid,
      latestMessageId: latest?.id ?? '',
      from: latest?.from_addr ?? '',
      subject: latest?.subject ?? '',
      snippet: latest?.snippet ?? '',
      date: latest?.date ?? h.last_date,
      isStarred: all.some((m) => m.is_starred !== 0),
      flagColor: (flagged?.flag_color ?? null) as FlagColor | null,
      hasAttachments: all.some((m) => m.has_attachments !== 0),
      messageCount: unique.length,
      // Unread reflects only copies in the folder(s) being viewed — non-Inbox
      // Gmail label copies can carry stale is_read and shouldn't mark the
      // conversation unread in the Inbox.
      hasUnread: all.some((m) => scope.has(m.folder_id) && m.is_read === 0),
      participants: participants.length ? participants : [extractName(latest?.from_addr ?? '')]
    }
  })
}

export function countThreads(folderId: string | 'unified'): number {
  const scopeIds = threadScopeIds(folderId)
  if (scopeIds.length === 0) return 0
  const sqlite = getRawSqlite()
  const ph = scopeIds.map(() => '?').join(', ')
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM messages WHERE folder_id IN (${ph})
         GROUP BY account_id, COALESCE(thread_id, id)
       )`
    )
    .get(...scopeIds) as { n: number }
  return row.n
}

// The full conversation for a thread, across all folders in the account, oldest
// first (received + Sent interleave). Deduplicated by Message-ID so Gmail's
// per-label copies of the same email appear once.
export function getThread(accountId: string, threadKey: string, limit = 200): MessageDetail[] {
  const db = getDb()
  const allRows = db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.accountId, accountId),
        sql`COALESCE(${messages.threadId}, ${messages.id}) = ${threadKey}`
      )
    )
    .orderBy(messages.date)
    .limit(limit)
    .all()
  if (allRows.length === 0) return []

  const seen = new Set<string>()
  const rows: typeof allRows = []
  for (const r of allRows) {
    const key = r.messageId ?? r.id
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(r)
  }

  const ids = rows.map((r) => r.id)
  const atts = db.select().from(attachments).where(inArray(attachments.messageId, ids)).all()
  const byMessage = new Map<string, typeof atts>()
  for (const a of atts) {
    const list = byMessage.get(a.messageId) ?? []
    list.push(a)
    byMessage.set(a.messageId, list)
  }

  return rows.map((r) => ({
    ...rowToSummary(r),
    cc: r.cc ?? '',
    references: r.references ?? null,
    bodyHtml: r.bodyHtml,
    bodyText: r.bodyText,
    attachments: (byMessage.get(r.id) ?? []).map((a) => ({
      id: a.id,
      messageId: a.messageId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      localPath: a.localPath
    }))
  }))
}

export interface SweepMessage {
  id: string
  from: string
  subject: string
  date: number
  bodyText: string | null
  bodyHtml: string | null
  sweepCache: string | null
}

// Messages in a folder (or the unified inbox) for an AI sweep, most recent
// first, capped. `scope` decides whether only unread mail is considered ('unread',
// the default) or every synced message in the folder ('all').
export function listMessagesForSweep(
  folderId: string | 'unified',
  scope: SweepScope,
  limit = 40
): SweepMessage[] {
  const db = getDb()
  const cols = {
    id: messages.id,
    from: messages.from,
    subject: messages.subject,
    date: messages.date,
    bodyText: messages.bodyText,
    bodyHtml: messages.bodyHtml,
    sweepCache: messages.sweepCache
  }
  const unreadOnly = scope === 'unread'

  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return []
    const scoped = inArray(messages.folderId, inboxIds)
    return db
      .select(cols)
      .from(messages)
      .where(unreadOnly ? and(scoped, eq(messages.isRead, false)) : scoped)
      .orderBy(desc(messages.date))
      .limit(limit)
      .all()
  }

  const scoped = eq(messages.folderId, folderId)
  return db
    .select(cols)
    .from(messages)
    .where(unreadOnly ? and(scoped, eq(messages.isRead, false)) : scoped)
    .orderBy(desc(messages.date))
    .limit(limit)
    .all()
}

// ---------------------------------------------------------------------------
// Persisted sweep tasks. `open` rows are the outstanding tasks from the most
// recent sweep of a folder; `completed` rows are a durable history the user has
// ticked off. Both are keyed by (folderId, id) where id is a stable dedupe key.
// ---------------------------------------------------------------------------

interface SweepTaskRow {
  id: string
  task: string
  priority: SweepTask['priority']
  source_message_id: string
  source_subject: string
  source_from: string
  completed_at: number | null
}

function rowToSweepTask(r: SweepTaskRow): SweepTask {
  return {
    id: r.id,
    task: r.task,
    priority: r.priority,
    sourceMessageId: r.source_message_id,
    sourceSubject: r.source_subject,
    sourceFrom: r.source_from
  }
}

export function listOpenSweepTasks(folderId: string | 'unified'): SweepTask[] {
  const rows = getRawSqlite()
    .prepare(
      `SELECT id, task, priority, source_message_id, source_subject, source_from, completed_at
       FROM sweep_tasks WHERE folder_id = ? AND status = 'open'
       ORDER BY created_at DESC`
    )
    .all(folderId) as SweepTaskRow[]
  return rows.map(rowToSweepTask)
}

export function listCompletedSweepTasks(folderId: string | 'unified'): CompletedTask[] {
  const rows = getRawSqlite()
    .prepare(
      `SELECT id, task, priority, source_message_id, source_subject, source_from, completed_at
       FROM sweep_tasks WHERE folder_id = ? AND status = 'completed'
       ORDER BY completed_at DESC`
    )
    .all(folderId) as SweepTaskRow[]
  return rows.map((r) => ({ ...rowToSweepTask(r), completedAt: r.completed_at ?? 0 }))
}

// Replace the open tasks for a folder with a fresh set, leaving completed rows
// untouched. Any incoming task whose id already exists as completed is skipped.
export function replaceOpenSweepTasks(
  folderId: string | 'unified',
  tasks: SweepTask[],
  at: number
): void {
  const db = getRawSqlite()
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM sweep_tasks WHERE folder_id = ? AND status = 'open'`).run(folderId)
    const insert = db.prepare(
      `INSERT INTO sweep_tasks
         (folder_id, id, task, priority, source_message_id, source_subject, source_from, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
       ON CONFLICT(folder_id, id) DO NOTHING`
    )
    for (const t of tasks) {
      insert.run(
        folderId,
        t.id,
        t.task,
        t.priority,
        t.sourceMessageId,
        t.sourceSubject,
        t.sourceFrom,
        at
      )
    }
  })
  tx()
}

export function completeSweepTask(
  folderId: string | 'unified',
  taskId: string,
  at: number
): void {
  getRawSqlite()
    .prepare(
      `UPDATE sweep_tasks SET status = 'completed', completed_at = ?
       WHERE folder_id = ? AND id = ?`
    )
    .run(at, folderId, taskId)
}

export function reopenSweepTask(folderId: string | 'unified', taskId: string): void {
  getRawSqlite()
    .prepare(
      `UPDATE sweep_tasks SET status = 'open', completed_at = NULL
       WHERE folder_id = ? AND id = ?`
    )
    .run(folderId, taskId)
}

// Drop completed tasks older than the cutoff so history stays bounded.
export function pruneCompletedSweepTasks(before: number): void {
  getRawSqlite()
    .prepare(`DELETE FROM sweep_tasks WHERE status = 'completed' AND completed_at < ?`)
    .run(before)
}

// Lightweight per-folder sweep metadata (last run time, message count analyzed,
// and the scope used) stored as a single JSON blob in app_preferences.
export interface SweepMeta {
  analyzedCount: number
  sweptAt: number
  scope: SweepScope
}

const SWEEP_META_KEY = 'ai_sweep_meta'

function readSweepMetaMap(): Record<string, SweepMeta> {
  const row = getRawSqlite()
    .prepare('SELECT value FROM app_preferences WHERE key = ?')
    .get(SWEEP_META_KEY) as { value: string } | undefined
  if (!row) return {}
  try {
    return JSON.parse(row.value) as Record<string, SweepMeta>
  } catch {
    return {}
  }
}

export function getSweepMeta(folderId: string | 'unified'): SweepMeta | null {
  return readSweepMetaMap()[folderId] ?? null
}

export function setSweepMeta(folderId: string | 'unified', meta: SweepMeta): void {
  const map = readSweepMetaMap()
  map[folderId] = meta
  getRawSqlite()
    .prepare(
      `INSERT INTO app_preferences (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(SWEEP_META_KEY, JSON.stringify(map))
}

export function getMessage(messageId: string): MessageDetail | null {
  const db = getDb()
  const r = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!r) return null
  const atts = db.select().from(attachments).where(eq(attachments.messageId, messageId)).all()
  return {
    ...rowToSummary(r),
    cc: r.cc ?? '',
    references: r.references ?? null,
    bodyHtml: r.bodyHtml,
    bodyText: r.bodyText,
    attachments: atts.map((a) => ({
      id: a.id,
      messageId: a.messageId,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
      localPath: a.localPath
    }))
  }
}

export interface ThreadContextMessage {
  id: string
  from: string
  to: string
  subject: string
  date: number
  bodyText: string | null
  bodyHtml: string | null
}

// All messages in a conversation for an account (across folders), oldest first.
// Lightweight projection for AI reply-draft grounding.
export function listThreadMessages(
  accountId: string,
  threadId: string,
  limit = 30
): ThreadContextMessage[] {
  const db = getDb()
  return db
    .select({
      id: messages.id,
      from: messages.from,
      to: messages.to,
      subject: messages.subject,
      date: messages.date,
      bodyText: messages.bodyText,
      bodyHtml: messages.bodyHtml
    })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), eq(messages.threadId, threadId)))
    .orderBy(messages.date)
    .limit(limit)
    .all()
}

export function getMessageAiAnalysis(
  messageId: string
): { json: string; at: number } | null {
  const db = getDb()
  const r = db
    .select({ aiAnalysis: messages.aiAnalysis, aiAnalysisAt: messages.aiAnalysisAt })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!r || !r.aiAnalysis) return null
  return { json: r.aiAnalysis, at: r.aiAnalysisAt ?? 0 }
}

export function setMessageAiAnalysis(messageId: string, json: string, at: number): void {
  const db = getDb()
  db.update(messages)
    .set({ aiAnalysis: json, aiAnalysisAt: at })
    .where(eq(messages.id, messageId))
    .run()
}

// Cache the tasks the model extracted for a single message so later sweeps can
// skip re-analyzing it. `json` is a JSON array of { task, priority } (possibly
// empty, which records "analyzed, produced no tasks").
export function setMessageSweepCache(messageId: string, json: string, at: number): void {
  const db = getDb()
  db.update(messages)
    .set({ sweepCache: json, sweepCacheAt: at })
    .where(eq(messages.id, messageId))
    .run()
}

export function getFolderMaxUid(folderId: string): number | null {
  const db = getDb()
  const folder = db.select().from(folders).where(eq(folders.id, folderId)).get()
  const row = db
    .select({ maxUid: max(messages.uid) })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .get()

  const messageMax = row?.maxUid ?? 0
  const storedMax = folder?.highestSyncedUid ?? 0
  const effective = Math.max(messageMax, storedMax)
  return effective > 0 ? effective : null
}

export function getFolderUidValidity(folderId: string): number | null {
  const db = getDb()
  const folder = db.select().from(folders).where(eq(folders.id, folderId)).get()
  return folder?.uidValidity ?? null
}

export function updateFolderSyncState(
  folderId: string,
  patch: {
    uidValidity?: number | null
    highestSyncedUid?: number
    lastSyncAt?: number
    initialSyncComplete?: boolean
  }
): void {
  const db = getDb()
  const updates: Partial<typeof folders.$inferInsert> = {}

  if (patch.uidValidity !== undefined) updates.uidValidity = patch.uidValidity
  if (patch.highestSyncedUid !== undefined) {
    updates.highestSyncedUid = patch.highestSyncedUid
  }
  if (patch.lastSyncAt !== undefined) updates.lastSyncAt = patch.lastSyncAt
  if (patch.initialSyncComplete !== undefined) {
    updates.initialSyncComplete = patch.initialSyncComplete
  }

  if (Object.keys(updates).length === 0) return

  db.update(folders).set(updates).where(eq(folders.id, folderId)).run()
}

export function clearFolderMessages(folderId: string): void {
  const db = getDb()
  const messageRows = db
    .select({ id: messages.id })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .all()

  for (const row of messageRows) {
    deleteAttachmentFilesForMessage(row.id)
    deleteFts(row.id)
  }

  db.delete(messages).where(eq(messages.folderId, folderId)).run()
  updateFolderSyncState(folderId, {
    highestSyncedUid: 0,
    initialSyncComplete: false,
    lastSyncAt: null
  })
}

export function hasMessageUid(folderId: string, uid: number): boolean {
  const db = getDb()
  const row = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.folderId, folderId), eq(messages.uid, uid)))
    .get()
  return Boolean(row)
}

export function getFolderUidSet(folderId: string): Set<number> {
  const db = getDb()
  const rows = db
    .select({ uid: messages.uid })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .all()
  return new Set(rows.map((r) => r.uid))
}

export interface UpsertMessageData {
  folderId: string
  accountId: string
  uid: number
  messageId?: string
  inReplyTo?: string | null
  references?: string | null
  threadId?: string | null
  from: string
  to: string
  cc?: string
  subject: string
  snippet: string
  date: number
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
  bodyHtml?: string | null
  bodyText?: string | null
}

export function upsertMessage(data: UpsertMessageData): { id: string; isNew: boolean } {
  const db = getDb()
  const existing = db
    .select()
    .from(messages)
    .where(and(eq(messages.folderId, data.folderId), eq(messages.uid, data.uid)))
    .get()

  const id = existing?.id ?? randomUUID()
  const isNew = !existing

  if (existing) {
    db.update(messages)
      .set({
        messageId: data.messageId,
        inReplyTo: data.inReplyTo,
        references: data.references,
        threadId: data.threadId,
        from: data.from,
        to: data.to,
        cc: data.cc,
        subject: data.subject,
        snippet: data.snippet,
        date: data.date,
        isRead: data.isRead,
        isStarred: data.isStarred,
        flagColor: data.isStarred ? existing.flagColor : null,
        hasAttachments: data.hasAttachments,
        bodyHtml: data.bodyHtml,
        bodyText: data.bodyText
      })
      .where(eq(messages.id, id))
      .run()
  } else {
    db.insert(messages).values({
      id,
      folderId: data.folderId,
      accountId: data.accountId,
      uid: data.uid,
      messageId: data.messageId,
      inReplyTo: data.inReplyTo,
      references: data.references,
      threadId: data.threadId,
      from: data.from,
      to: data.to,
      cc: data.cc,
      subject: data.subject,
      snippet: data.snippet,
      date: data.date,
      isRead: data.isRead,
      isStarred: data.isStarred,
      hasAttachments: data.hasAttachments,
      bodyHtml: data.bodyHtml,
      bodyText: data.bodyText
    }).run()
  }

  upsertFts(id, data.subject, data.snippet, data.bodyText, data.bodyHtml)
  return { id, isNew }
}

// Upsert a batch of messages in a single transaction. Each message otherwise
// commits ~4 statements (select + insert/update + FTS delete/insert) on its own
// WAL commit; batching a folder's fetch collapses that to one commit.
export function upsertMessagesBatch(
  rows: UpsertMessageData[]
): { id: string; isNew: boolean }[] {
  if (rows.length === 0) return []
  const db = getDb()
  return db.transaction(() => rows.map((row) => upsertMessage(row)))
}

export function updateFolderUnread(folderId: string, count: number): void {
  const db = getDb()
  db.update(folders).set({ unreadCount: count }).where(eq(folders.id, folderId)).run()
}

export function recalculateFolderUnread(folderId: string): number {
  const db = getDb()
  const row = db
    .select({ value: count() })
    .from(messages)
    .where(and(eq(messages.folderId, folderId), eq(messages.isRead, false)))
    .get()
  const unread = row?.value ?? 0
  updateFolderUnread(folderId, unread)
  return unread
}

export function setMessageRead(messageId: string, isRead: boolean): void {
  const db = getDb()
  const existing = db
    .select({
      folderId: messages.folderId,
      accountId: messages.accountId,
      msgId: messages.messageId
    })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!existing) return

  // Gmail stores one copy per label (folder). Flip read state on every copy of
  // this email so the Inbox dot clears no matter which copy was opened, and so
  // folder unread counts stay consistent.
  if (existing.msgId) {
    const copies = db
      .select({ id: messages.id, folderId: messages.folderId })
      .from(messages)
      .where(
        and(eq(messages.accountId, existing.accountId), eq(messages.messageId, existing.msgId))
      )
      .all()
    db.update(messages)
      .set({ isRead })
      .where(
        and(eq(messages.accountId, existing.accountId), eq(messages.messageId, existing.msgId))
      )
      .run()
    const folderIds = Array.from(new Set(copies.map((c) => c.folderId)))
    for (const folderId of folderIds) recalculateFolderUnread(folderId)
  } else {
    db.update(messages).set({ isRead }).where(eq(messages.id, messageId)).run()
    recalculateFolderUnread(existing.folderId)
  }
}

export function setMessageStarred(messageId: string, isStarred: boolean): void {
  const db = getDb()
  if (isStarred) {
    db.update(messages).set({ isStarred: true }).where(eq(messages.id, messageId)).run()
  } else {
    db.update(messages)
      .set({ isStarred: false, flagColor: null })
      .where(eq(messages.id, messageId))
      .run()
  }
}

export function setMessageFlag(messageId: string, flagColor: FlagColor | null): void {
  const db = getDb()
  db.update(messages)
    .set({
      flagColor,
      isStarred: flagColor !== null
    })
    .where(eq(messages.id, messageId))
    .run()
}

export function countMessages(folderId: string | 'unified'): number {
  const db = getDb()

  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return 0
    const row = db
      .select({ value: count() })
      .from(messages)
      .where(inArray(messages.folderId, inboxIds))
      .get()
    return row?.value ?? 0
  }

  const row = db
    .select({ value: count() })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .get()
  return row?.value ?? 0
}

export function deleteMessage(messageId: string): void {
  const db = getDb()
  const existing = db
    .select({ folderId: messages.folderId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  deleteAttachmentFilesForMessage(messageId)
  deleteFts(messageId)
  db.delete(messages).where(eq(messages.id, messageId)).run()
  if (existing) {
    recalculateFolderUnread(existing.folderId)
  }
}

function deleteAttachmentFilesForMessage(messageId: string): void {
  const db = getDb()
  const rows = db
    .select({ localPath: attachments.localPath })
    .from(attachments)
    .where(eq(attachments.messageId, messageId))
    .all()

  for (const row of rows) {
    if (!row.localPath) continue
    try {
      if (existsSync(row.localPath)) unlinkSync(row.localPath)
    } catch {
      // ignore missing files
    }
  }
}

export function addAttachment(
  messageId: string,
  filename: string,
  mimeType: string,
  size: number,
  localPath: string | null
): string {
  const db = getDb()
  const id = randomUUID()
  db.insert(attachments).values({
    id,
    messageId,
    filename,
    mimeType,
    size,
    localPath
  }).run()
  return id
}

export function updateAttachmentLocalPath(attachmentId: string, localPath: string): void {
  const db = getDb()
  db.update(attachments).set({ localPath }).where(eq(attachments.id, attachmentId)).run()
}

export function pruneMessagesOutsideSyncWindow(accountId: string, syncDays: number): number {
  if (syncDays <= 0) return 0

  const cutoff = getSyncCutoffTimestamp(syncDays)
  if (cutoff == null) return 0

  const db = getDb()
  const stale = db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.accountId, accountId), lt(messages.date, cutoff)))
    .all()

  for (const row of stale) {
    deleteMessage(row.id)
  }

  return stale.length
}

export function getAccountStorageUsage(accountId: string): {
  contentBytes: number
  attachmentBytes: number
  attachmentCount: number
  downloadedAttachmentCount: number
} {
  const sqlite = getRawSqlite()
  const contentRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(
         LENGTH(COALESCE(body_html, '')) +
         LENGTH(COALESCE(body_text, '')) +
         LENGTH(subject) +
         LENGTH(snippet)
       ), 0) AS content_bytes
       FROM messages
       WHERE account_id = ?`
    )
    .get(accountId) as { content_bytes: number }

  const attachmentRows = sqlite
    .prepare(
      `SELECT a.local_path, a.size
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       WHERE m.account_id = ?`
    )
    .all(accountId) as Array<{ local_path: string | null; size: number }>

  let attachmentBytes = 0
  let downloadedAttachmentCount = 0

  for (const row of attachmentRows) {
    if (row.local_path && existsSync(row.local_path)) {
      downloadedAttachmentCount++
      attachmentBytes += statSync(row.local_path).size
    }
  }

  return {
    contentBytes: contentRow.content_bytes,
    attachmentBytes,
    attachmentCount: attachmentRows.length,
    downloadedAttachmentCount
  }
}

export function getAttachment(attachmentId: string) {
  const db = getDb()
  return db.select().from(attachments).where(eq(attachments.id, attachmentId)).get()
}

type SearchRow = {
  id: string
  folder_id: string
  account_id: string
  uid: number
  message_id: string | null
  from_addr: string
  to_addr: string
  subject: string
  snippet: string
  date: number
  is_read: number
  is_starred: number
  flag_color: string | null
  has_attachments: number
  thread_id: string | null
}

function mapSearchRows(rows: SearchRow[]): MessageSummary[] {
  return rows.map((r) => ({
    id: r.id,
    folderId: r.folder_id,
    accountId: r.account_id,
    uid: r.uid,
    messageId: r.message_id,
    from: r.from_addr,
    to: r.to_addr,
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    isRead: Boolean(r.is_read),
    isStarred: Boolean(r.is_starred),
    flagColor: (r.flag_color as FlagColor | null) ?? null,
    hasAttachments: Boolean(r.has_attachments),
    threadId: r.thread_id
  }))
}

const SEARCH_SELECT = `SELECT m.id, m.folder_id, m.account_id, m.uid, m.message_id,
              m.from_addr, m.to_addr, m.subject, m.snippet, m.date,
              m.is_read, m.is_starred, m.flag_color, m.has_attachments, m.thread_id`

function searchMessagesFts(
  sqlite: ReturnType<typeof getRawSqlite>,
  ftsQuery: string,
  accountId: string,
  limit: number
): MessageSummary[] {
  const rows = sqlite
    .prepare(
      `${SEARCH_SELECT}
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.message_id
       WHERE messages_fts MATCH ? AND m.account_id = ?
       ORDER BY rank, m.date DESC
       LIMIT ?`
    )
    .all(ftsQuery, accountId, limit) as SearchRow[]

  return mapSearchRows(rows)
}

function searchMessagesLike(
  sqlite: ReturnType<typeof getRawSqlite>,
  likePattern: string,
  accountId: string,
  limit: number
): MessageSummary[] {
  const rows = sqlite
    .prepare(
      `${SEARCH_SELECT}
       FROM messages m
       WHERE m.account_id = ?
         AND (
           m.subject LIKE ? COLLATE NOCASE OR
           m.snippet LIKE ? COLLATE NOCASE OR
           m.body_text LIKE ? COLLATE NOCASE OR
           m.body_html LIKE ? COLLATE NOCASE
         )
       ORDER BY m.date DESC
       LIMIT ?`
    )
    .all(accountId, likePattern, likePattern, likePattern, likePattern, limit) as SearchRow[]

  return mapSearchRows(rows)
}

export function searchMessages(text: string, accountId: string, limit = 50): MessageSummary[] {
  const sqlite = getRawSqlite()
  const ftsQuery = buildFtsQuery(text)
  const likePattern = buildLikePattern(text)
  if ((!ftsQuery && !likePattern) || !accountId) return []

  if (ftsQuery) {
    try {
      const ftsResults = searchMessagesFts(sqlite, ftsQuery, accountId, limit)
      if (ftsResults.length > 0) return ftsResults
    } catch {
      // Fall back to LIKE if the FTS query is malformed.
    }
  }

  if (likePattern) {
    return searchMessagesLike(sqlite, likePattern, accountId, limit)
  }

  return []
}
