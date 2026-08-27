import { randomUUID } from 'crypto'
import { existsSync, statSync, unlinkSync } from 'fs'
import { eq, desc, and, inArray, max, count, lt, sql } from 'drizzle-orm'
import { getDb, getRawSqlite } from '../db'
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
  SearchField,
  SweepScope,
  SweepTask,
  CompletedTask,
  DraftSummary
} from '../../shared/types'
import {
  encryptCredentials,
  decryptCredentials,
  type TokenData,
  type ManualAccountCredentials,
  type AccountCredentials
} from './account-credentials'
import { DEFAULT_SYNC_DAYS, getSyncCutoffTimestamp } from './sync-policy'
import { buildLikePattern, messageSearchableBody } from './search-index'
import { normalizeSubject } from './thread-util'
import { collectDisplayNames, extractName } from '../../shared/addresses'
import { harvestContacts } from './contacts'
import { getBlockedSenders, isSenderMuted } from './preferences-service'
import { listDrafts, countDrafts } from './draft-service'

export type { TokenData, ManualAccountCredentials, AccountCredentials }

const PROVIDER_LABELS: Record<Provider, string> = {
  gmail: 'Gmail',
  o365: 'Office 365',
  imap: 'IMAP',
  pop3: 'POP3'
}

// Accounts are keyed by address, so re-adding one updates it in place — that is
// how re-authenticating and changing a password work. Switching *provider* is a
// different thing: it replaces the stored credentials (an OAuth refresh token
// cannot be recovered afterwards) and silently changes how the account's
// existing mail is treated, since Gmail's label folders and search behave
// differently from plain IMAP. Refuse it and let the user remove the account
// deliberately, which is the path that also cleans up its mail.
function assertProviderUnchanged(
  email: string,
  existing: { provider: string } | undefined,
  provider: Provider
): void {
  if (!existing || existing.provider === provider) return
  const from = PROVIDER_LABELS[existing.provider as Provider] ?? existing.provider
  const to = PROVIDER_LABELS[provider] ?? provider
  throw new Error(
    `${email} is already added as ${from}. Remove that account first to add it as ${to}.`
  )
}

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

  assertProviderUnchanged(tokenData.email, existing, provider)

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

  assertProviderUnchanged(creds.email, existing, provider)

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

/**
 * The account's signature, as stored. Empty string when it has none.
 *
 * **This is not sanitized here.** `sanitizeEmailHtml` needs a DOM, which the
 * main process does not have, so the settings pane cleans it before saving and
 * `RichTextEditor` cleans whatever it is given again on mount — the signature
 * lands in the compose body, so it passes through that second gate on every
 * message. The content originates from the user's own typing in our own editor;
 * the risk being managed is malformed markup reaching outgoing mail, not an
 * attacker.
 */
export function getAccountSignature(accountId: string): string {
  const row = getDb()
    .select({ signature: accounts.signature })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()
  return row?.signature ?? ''
}

export function setAccountSignature(accountId: string, signature: string): void {
  getDb()
    .update(accounts)
    .set({ signature: signature.trim() || null })
    .where(eq(accounts.id, accountId))
    .run()
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

  // sweep_tasks (AI Tasks) have no foreign key, so the account cascade below does
  // not reach them. Delete this account's tasks explicitly, before the cascade
  // drops the folders and messages the subqueries reference:
  //   - per-folder sweeps, keyed by one of the account's folder ids
  //   - unified-inbox sweeps, which are keyed by 'unified' but whose
  //     source_message_id points at one of this account's messages
  // Other accounts' unified tasks reference their own messages, so they are left
  // untouched. Runs on the same synchronous connection as the delete below.
  sqlite
    .prepare(
      `DELETE FROM sweep_tasks
       WHERE folder_id IN (SELECT id FROM folders WHERE account_id = ?)
          OR source_message_id IN (SELECT id FROM messages WHERE account_id = ?)`
    )
    .run(accountId, accountId)

  // contacts have a foreign key, so the cascade below clears them with the
  // account — nothing collected from this mailbox outlives it.
  const db = getDb()
  db.delete(accounts).where(eq(accounts.id, accountId)).run()
  accountEmailCache.delete(accountId)
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
    // Re-type on every sync. The type used to be frozen at first sight, so a
    // folder mis-typed once stayed that way forever — an account whose real
    // Trash was typed `custom` kept sending deletes to whatever else claimed
    // `trash`, and no detection fix could reach an existing install.
    const patch: { isVirtualView?: boolean; type?: FolderType } = {}
    if (existing.isVirtualView !== isVirtualView) patch.isVirtualView = isVirtualView
    if (existing.type !== type) patch.type = type
    if (Object.keys(patch).length > 0) {
      db.update(folders).set(patch).where(eq(folders.id, existing.id)).run()
    }
    return {
      id: existing.id,
      accountId: existing.accountId,
      imapPath: existing.imapPath,
      name: existing.name,
      type,
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
  /**
   * The row this notification would be about. Carried so the notifier can tell
   * whether it is about to repeat itself: IDLE and the safety-net poll announce
   * new mail independently, and without an identity the only possible guard is
   * "was I noisy recently", which lets the same message through twice as soon as
   * the two land more than a few seconds apart.
   */
  id: string
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

  // This is what a new-mail notification names, so it skips senders the user
  // has muted as well as blocked — mute means "do not interrupt me about this
  // person", and the notification is the interruption. Taking a few rows and
  // filtering in JS keeps the muted check next to isSenderMuted rather than
  // rebuilding its address matching in SQL.
  const rows = db
    .select({
      id: messages.id,
      from: messages.from,
      subject: messages.subject,
      accountId: messages.accountId
    })
    .from(messages)
    .where(and(inArray(messages.folderId, inboxIds), blockedDrizzleCondition(blockedFor('unified'))))
    .orderBy(desc(messages.date))
    .limit(20)
    .all()

  const row = rows.find((candidate) => !isSenderMuted(candidate.from))
  if (!row) return null

  const account = db.select().from(accounts).where(eq(accounts.id, row.accountId)).get()
  return {
    id: row.id,
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
  offset = 0,
  unreadOnly = false
): MessageSummary[] {
  const db = getDb()

  let scope
  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return []
    scope = inArray(messages.folderId, inboxIds)
  } else {
    scope = eq(messages.folderId, folderId)
  }

  const where = and(
    unreadOnly ? and(scope, eq(messages.isRead, false)) : scope,
    blockedDrizzleCondition(blockedFor(folderId))
  )
  const rows = db
    .select(SUMMARY_COLS)
    .from(messages)
    .where(where)
    .orderBy(desc(messages.date))
    .limit(limit)
    .offset(offset)
    .all()

  const synced = rows.map(rowToSummary)

  // Local drafts sit at the top of the Drafts folder. Only on the first page —
  // they are prepended rather than sorted in, so paging past them would repeat
  // them on every page.
  const draftAccount = draftsFolderAccount(folderId)
  if (draftAccount && offset === 0 && !unreadOnly) {
    return [...listDrafts(draftAccount).map((d) => draftAsSummary(d, folderId)), ...synced]
  }
  return synced
}

// ---------------------------------------------------------------------------
// Conversation threading. The list groups the current folder's messages into
// threads (one row per conversation); opening a thread pulls the full
// conversation across folders (getThread). Grouping key is COALESCE(thread_id,
// id) scoped per account, so a message without a thread_id is its own thread and
// subject-fallback keys never merge across accounts.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Blocked senders.
//
// Filtering happens **at query time**, in every read site, not at sync time.
// Two sync-time designs were tried and rejected: re-filing a blocked sender's
// mail into Junk collides with `UNIQUE(folder_id, uid)` (uid is folder-scoped,
// so an Inbox uid moved under the Junk folder id can hit a real Junk message),
// and skipping it at ingest is worse — IMAP only fetches UIDs above
// `highestSyncedUid`, so skipped mail is gone for good and Block becomes silent,
// irreversible data loss that behaves one way for already-cached mail and
// another for new. Filtering on read applies to both with the same code, and
// unblocking restores everything instantly with no refetch.
//
// The cost: `from_addr` stores the display form (`"Name" <addr>`), not a
// normalized address, so this is a LIKE per blocked entry and **cannot use an
// index**. A `from_normalized` column plus a backfill is the sub-linear
// follow-up; see TODO.md.
//
// Every read site must apply this or the unread badge disagrees with the list,
// which is worse than not blocking at all.
// ---------------------------------------------------------------------------

// A guard on SQL size, not a product decision. Someone with more blocked
// senders than this keeps the first 200 filtered.
const MAX_BLOCKED_PREDICATES = 200

function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\_%]/g, '\\$&')
}

/**
 * The blocked addresses that apply to a folder.
 *
 * **Sent folders are exempt.** A Sent row's `from_addr` is always the user, so
 * if one of their own addresses ever reached the blocklist the predicate would
 * empty their entire Sent list. `preferences:blockSender` refuses own addresses
 * too; this is the second lock on the same door.
 */
function blockedFor(folderId: string | 'unified'): string[] {
  if (folderId !== 'unified' && isSentFolder(folderId)) return []
  return getBlockedSenders().slice(0, MAX_BLOCKED_PREDICATES)
}

/**
 * Match the address inside the angle brackets, or a bare address on its own —
 * never a bare substring. `LIKE '%bob@x.com%'` would also hide mail from
 * `notbob@x.com`, which is a silent, baffling way to lose mail.
 *
 * A display name is attacker-controlled, so a sender *can* get their own mail
 * hidden by putting a blocked address in their display name. They cannot use it
 * to escape a block, which is the direction that matters.
 */
function blockedDrizzleCondition(addresses: string[]) {
  if (addresses.length === 0) return undefined
  return and(
    ...addresses.map(
      (address) =>
        sql`NOT (lower(${messages.from}) LIKE ${`%<${escapeLikeLiteral(address)}>%`} ESCAPE '\\'
             OR lower(trim(${messages.from})) = ${address})`
    )
  )
}

/** The same predicate for the raw-SQL read paths. */
function blockedSqlFragment(
  addresses: string[],
  column: string
): { clause: string; params: string[] } {
  if (addresses.length === 0) return { clause: '', params: [] }
  const clause = addresses
    .map(() => ` AND NOT (lower(${column}) LIKE ? ESCAPE '\\' OR lower(trim(${column})) = ?)`)
    .join('')
  const params = addresses.flatMap((address) => [`%<${escapeLikeLiteral(address)}>%`, address])
  return { clause, params }
}

// ---------------------------------------------------------------------------
// Local drafts in the Drafts folder.
//
// Drafts live in their own table (see schema.ts for why), so the Drafts folder
// has to merge them in on read. They are prepended: a draft is always newer than
// anything synced, and it is what the user came to the folder for.
// ---------------------------------------------------------------------------

function draftsFolderAccount(folderId: string | 'unified'): string | null {
  if (folderId === 'unified') return null
  const row = getDb()
    .select({ type: folders.type, accountId: folders.accountId })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get()
  return row?.type === 'drafts' ? row.accountId : null
}

function draftAsSummary(draft: DraftSummary, folderId: string): MessageSummary {
  return {
    id: `draft:${draft.id}`,
    folderId,
    accountId: draft.accountId,
    // Not a server message: uid 0 and no Message-ID. Nothing keys off these for
    // a draft row, and `draftId` is what tells every consumer what this is.
    uid: 0,
    messageId: null,
    from: '',
    to: draft.to,
    subject: draft.subject || '(no subject)',
    snippet: draft.snippet,
    date: draft.updatedAt,
    isRead: true,
    isStarred: false,
    flagColor: null,
    hasAttachments: draft.hasAttachments,
    threadId: null,
    draftId: draft.id
  }
}

// A Sent folder's rows are about the recipient — the sender is always us.
function isSentFolder(folderId: string | 'unified'): boolean {
  if (folderId === 'unified') return false
  const db = getDb()
  const row = db
    .select({ type: folders.type })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get()
  return row?.type === 'sent'
}

// Folder ids the current view scopes to (unified = every inbox). Empty = nothing.
function threadScopeIds(folderId: string | 'unified'): string[] {
  return folderId === 'unified' ? getInboxFolderIds() : [folderId]
}

// ---------------------------------------------------------------------------
// Thread regrouping — union-find over RFC 5322 Message-ID relationships.
//
// Keying a message by references[0] alone splits a conversation whenever a
// client sends In-Reply-To but omits References (the reply keys to its parent
// instead of the root). Here we link every message to every id it mentions
// (own Message-ID, In-Reply-To, all References) and assign the whole connected
// set one stable thread_id, so those splits merge back together.
// ---------------------------------------------------------------------------

// Canonicalize a Message-ID for comparison: trim, drop one pair of surrounding
// angle brackets, lowercase. (Message-IDs are practically case-insensitive and
// clients vary on bracket/whitespace formatting.)
function canonicalizeMessageId(raw: string | null | undefined): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1)
  s = s.trim().toLowerCase()
  return s.length > 0 ? s : null
}

// Split a raw References / In-Reply-To header into canonical id tokens.
function tokenizeReferences(raw: string | null | undefined): string[] {
  if (!raw) return []
  const out: string[] = []
  for (const token of raw.split(/\s+/)) {
    const id = canonicalizeMessageId(token)
    if (id) out.push(id)
  }
  return out
}

interface RegroupRow {
  id: string
  message_id: string | null
  in_reply_to: string | null
  references: string | null
  thread_id: string | null
  subject: string
  date: number
}

// Recompute thread_id for every message in an account so that messages linked
// (transitively) by Message-ID / In-Reply-To / References share one id.
export function regroupThreadsForAccount(accountId: string): void {
  try {
    regroupThreadsForAccountInner(accountId)
  } finally {
    // Regrouping is the one thing that can make a thread key *stop existing*, so
    // it is where cached summaries keyed on one are collected. In the callee
    // rather than at the three call sites, so a fourth cannot forget it — and in
    // a `finally` so the early return for an empty account still runs it.
    pruneOrphanedThreadAnalysis(accountId)
  }
}

function regroupThreadsForAccountInner(accountId: string): void {
  const sqlite = getRawSqlite()
  const rows = sqlite
    .prepare(
      `SELECT id, message_id, in_reply_to, "references", thread_id, subject, date
       FROM messages WHERE account_id = ?`
    )
    .all(accountId) as RegroupRow[]
  if (rows.length === 0) return

  // Union-find over canonical Message-ID tokens.
  const parent = new Map<string, string>()
  const makeSet = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x)
  }
  const find = (x: string): string => {
    let root = x
    while (parent.get(root) !== root) root = parent.get(root)!
    let cur = x
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    makeSet(a)
    makeSet(b)
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  for (const r of rows) {
    const own = canonicalizeMessageId(r.message_id)
    const refs = [...tokenizeReferences(r.references), ...tokenizeReferences(r.in_reply_to)]
    if (own) {
      makeSet(own)
      for (const ref of refs) union(own, ref)
    } else if (refs.length > 0) {
      // No Message-ID of its own: still cluster the ids it references together.
      for (let i = 1; i < refs.length; i++) union(refs[0], refs[i])
    }
  }

  // Stable representative per set: the canonical id of the earliest message in
  // it (tie-break lexicographically). Referenced-but-absent ids carry no date,
  // so a real message always wins the root — the conversation's opener.
  const repByRoot = new Map<string, { id: string; date: number }>()
  for (const r of rows) {
    const own = canonicalizeMessageId(r.message_id)
    if (!own) continue
    const root = find(own)
    const cur = repByRoot.get(root)
    if (!cur || r.date < cur.date || (r.date === cur.date && own < cur.id)) {
      repByRoot.set(root, { id: own, date: r.date })
    }
  }

  const update = sqlite.prepare('UPDATE messages SET thread_id = ? WHERE id = ?')
  const apply = sqlite.transaction((items: RegroupRow[]) => {
    for (const r of items) {
      const own = canonicalizeMessageId(r.message_id)
      const threadId = own
        ? repByRoot.get(find(own))?.id ?? own
        : `subj:${normalizeSubject(r.subject)}`
      if (threadId !== r.thread_id) update.run(threadId, r.id)
    }
  })
  apply(rows)
}

// Regroup every account (used by the one-time upgrade backfill).
export function regroupAllThreads(): void {
  const sqlite = getRawSqlite()
  const accountRows = sqlite.prepare('SELECT id FROM accounts').all() as Array<{ id: string }>
  for (const a of accountRows) regroupThreadsForAccount(a.id)
}

// Run the transitive regroup once on upgrade so existing split conversations
// merge. Guarded by a preferences flag so it only runs a single time.
export function regroupThreadsIfNeeded(): void {
  const sqlite = getRawSqlite()
  const done = sqlite
    .prepare("SELECT value FROM app_preferences WHERE key = 'thread_regroup_v2'")
    .get() as { value: string } | undefined
  if (done?.value === '1') return
  regroupAllThreads()
  sqlite
    .prepare(
      "INSERT INTO app_preferences (key, value) VALUES ('thread_regroup_v2', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run()
}

interface ThreadMsgRow {
  id: string
  aid: string
  tkey: string
  mkey: string
  folder_id: string
  from_addr: string
  to_addr: string
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
  offset = 0,
  unreadOnly = false
): ThreadSummary[] {
  const scopeIds = threadScopeIds(folderId)
  if (scopeIds.length === 0) return []
  const scope = new Set(scopeIds)
  const sentView = isSentFolder(folderId)
  const sqlite = getRawSqlite()
  const ph = scopeIds.map(() => '?').join(', ')
  // Unread-only restricts the conversation set to threads with an unread copy in
  // the viewed folder(s) — matching how hasUnread is computed below.
  const unreadClause = unreadOnly ? ' AND is_read = 0' : ''
  // Applied twice, deliberately. On the folder scan so a conversation made only
  // of blocked mail never appears; on the message rows so a blocked person's
  // reply inside an otherwise legitimate thread does not contribute to its
  // count, participants or latest message. Blocking hides that person's
  // messages, not every conversation they touched.
  const blocked = blockedFor(folderId)
  const blockScan = blockedSqlFragment(blocked, 'from_addr')
  const blockRows = blockedSqlFragment(blocked, 'from_addr')

  // Built before the empty-heads return below: a Drafts folder holding only
  // local drafts has no thread heads at all, and returning early there would
  // show an empty folder while the flat list showed the drafts.
  const draftAccount = draftsFolderAccount(folderId)
  const draftRows: ThreadSummary[] =
    draftAccount && offset === 0 && !unreadOnly
      ? listDrafts(draftAccount).map((draft) => ({
          threadId: `draft:${draft.id}`,
          accountId: draft.accountId,
          latestMessageId: `draft:${draft.id}`,
          from: '',
          subject: draft.subject || '(no subject)',
          snippet: draft.snippet,
          date: draft.updatedAt,
          isStarred: false,
          flagColor: null,
          hasAttachments: draft.hasAttachments,
          messageCount: 1,
          hasUnread: false,
          participants: collectDisplayNames([draft.to]),
          draftId: draft.id
        }))
      : []

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
           FROM messages WHERE folder_id IN (${ph})${unreadClause}${blockScan.clause}
         )
       )
       GROUP BY aid, tkey
       ORDER BY last_date DESC
       LIMIT ? OFFSET ?`
    )
    .all(...scopeIds, ...blockScan.params, limit, offset) as Array<{
    aid: string
    tkey: string
    last_date: number
  }>
  if (heads.length === 0) return draftRows

  // Every message in those conversations (across folders), lightweight columns.
  const pairs = heads.map(() => '(?, ?)').join(', ')
  const pairArgs: unknown[] = []
  for (const h of heads) pairArgs.push(h.aid, h.tkey)
  const rows = sqlite
    .prepare(
      `SELECT id, account_id AS aid, COALESCE(thread_id, id) AS tkey, COALESCE(message_id, id) AS mkey,
              folder_id, from_addr, to_addr, subject, snippet, date, is_read, is_starred, flag_color, has_attachments
       FROM messages
       WHERE (account_id, COALESCE(thread_id, id)) IN (VALUES ${pairs})${blockRows.clause}
       ORDER BY date ASC`
    )
    .all(...pairArgs, ...blockRows.params) as ThreadMsgRow[]

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

  const summaries: ThreadSummary[] = heads.map((h) => {
    const g = groups.get(`${h.aid} ${h.tkey}`)
    const unique = g?.unique ?? []
    const all = g?.all ?? []
    const latest = unique[unique.length - 1]
    // In a Sent folder the label is the recipients of our own copies, not the
    // senders (always us). Those copies are read from `all`, not `unique` — the
    // Message-ID dedupe can keep a Gmail All Mail copy of the same message and
    // drop the one that lives in Sent.
    const participants: string[] = []
    if (sentView) {
      const ourCopies = all.filter((m) => scope.has(m.folder_id))
      participants.push(...collectDisplayNames(ourCopies.map((m) => m.to_addr)))
    } else {
      for (const m of unique) {
        const name = extractName(m.from_addr)
        if (!participants.includes(name)) participants.push(name)
      }
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
      participants: participants.length
        ? participants
        : sentView
          ? collectDisplayNames([latest?.to_addr ?? ''])
          : [extractName(latest?.from_addr ?? '')]
    }
  })

  // A draft has no conversation, so each is its own one-message row at the top
  // — the same place and order the flat list puts them, so switching view does
  // not lose track of them.
  return draftRows.length > 0 ? [...draftRows, ...summaries] : summaries
}

export function countThreads(folderId: string | 'unified', unreadOnly = false): number {
  const scopeIds = threadScopeIds(folderId)
  if (scopeIds.length === 0) return 0
  const sqlite = getRawSqlite()
  const ph = scopeIds.map(() => '?').join(', ')
  const unreadClause = unreadOnly ? ' AND is_read = 0' : ''
  // Same predicate as listThreads' folder scan, or the count disagrees with the
  // number of conversations actually on screen.
  const block = blockedSqlFragment(blockedFor(folderId), 'from_addr')
  const row = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM messages WHERE folder_id IN (${ph})${unreadClause}${block.clause}
         GROUP BY account_id, COALESCE(thread_id, id)
       )`
    )
    .get(...scopeIds, ...block.params) as { n: number }
  return row.n
}

/**
 * The full conversation for a thread, across all folders in the account, oldest
 * first (received + Sent interleave). Deduplicated by Message-ID so Gmail's
 * per-label copies of the same email appear once.
 *
 * **When the limit bites it keeps the newest, and both halves of that were
 * wrong before.** It ordered ascending and limited, so a 250-message thread
 * returned messages 1–200 and hid everything recent — and the reader takes
 * `messages[length - 1]` as "the latest", which is what Reply, Reply All,
 * Forward and Draft reply all target. So a reply went out against a mid-thread
 * message: threaded under the wrong parent, and reply-all addressed to the
 * recipients of a message from months ago rather than the current ones. That is
 * mail sent to the wrong people, not a display quirk.
 *
 * The dedupe also ran *after* the limit, in JS, so Gmail's label copies spent
 * the budget: a thread whose messages each carry three labels hit the ceiling at
 * roughly 67 distinct messages rather than 200. It is `GROUP BY` now, so the
 * limit counts distinct messages — the same correction `listThreadMessages`
 * needed.
 */
export function getThread(accountId: string, threadKey: string, limit = 200): MessageDetail[] {
  const db = getDb()
  // Choose the newest `limit` distinct messages, then hand them back in reading
  // order. Two steps because the choice is by recency and the render is not.
  const chosen = getRawSqlite()
    .prepare(
      `SELECT id FROM (
         SELECT id, date FROM messages
         WHERE account_id = ? AND COALESCE(thread_id, id) = ?
         GROUP BY COALESCE(message_id, id)
         ORDER BY date DESC, COALESCE(message_id, id) DESC
         LIMIT ?
       ) ORDER BY date, id`
    )
    .all(accountId, threadKey, limit) as Array<{ id: string }>
  if (chosen.length === 0) return []

  const chosenIds = chosen.map((r) => r.id)
  const byId = new Map(
    db.select().from(messages).where(inArray(messages.id, chosenIds)).all().map((r) => [r.id, r])
  )
  // Ordered by the id list, not by re-sorting: the SQL above already settled
  // reading order, including how same-timestamp messages tie-break.
  const rows = chosenIds.map((id) => byId.get(id)!).filter(Boolean)

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
      localPath: a.localPath,
      inline: a.isInline
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
    // Only clear swept tasks — manually flagged tasks (source = 'manual') persist
    // across sweeps until the user completes them.
    db.prepare(
      `DELETE FROM sweep_tasks WHERE folder_id = ? AND status = 'open' AND source = 'sweep'`
    ).run(folderId)
    const insert = db.prepare(
      `INSERT INTO sweep_tasks
         (folder_id, id, task, priority, source_message_id, source_subject, source_from, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'sweep', ?)
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

// Insert a user-forced task from a specific email. Marked source = 'manual' so
// sweeps never delete it. If the same task id already exists (e.g. the user
// re-flags a completed one), reopen it rather than silently no-op.
export function insertManualSweepTask(
  folderId: string | 'unified',
  task: SweepTask,
  at: number
): void {
  getRawSqlite()
    .prepare(
      `INSERT INTO sweep_tasks
         (folder_id, id, task, priority, source_message_id, source_subject, source_from, status, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 'manual', ?)
       ON CONFLICT(folder_id, id) DO UPDATE SET
         status = 'open', completed_at = NULL, source = 'manual'`
    )
    .run(
      folderId,
      task.id,
      task.task,
      task.priority,
      task.sourceMessageId,
      task.sourceSubject,
      task.sourceFrom,
      at
    )
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
      localPath: a.localPath,
      inline: a.isInline
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

/**
 * All messages in a conversation for an account (across folders), oldest first.
 *
 * Lightweight projection — no attachments, no flags — for the AI features that
 * need the conversation as *text*: reply drafting and thread analysis.
 *
 * **Matched and deduplicated exactly as `getThread` does**, and both halves are
 * corrections rather than preferences. It used to match `thread_id` for equality,
 * which silently dropped every message whose `thread_id` is NULL — a message is
 * its own thread when it has no threading headers, so a one-message conversation
 * returned *nothing*. And it did not deduplicate, so on Gmail — where a label is
 * a folder and one email is stored once per label — an archived-and-starred
 * message appeared three times in the context handed to the model.
 *
 * The dedupe is `GROUP BY` rather than a filter in JS so `limit` still yields
 * that many *distinct* messages; deduplicating afterwards would silently return
 * fewer than asked for, which is worse on the path where the limit is the token
 * budget. Which row of a duplicate set survives does not matter: they are copies
 * of one email.
 *
 * **When the limit bites it keeps the newest, and returns them oldest-first.**
 * A plain `ORDER BY date LIMIT n` keeps the *oldest* n, which is the wrong end
 * of a conversation for everything that calls this: `draftReply` asks the model
 * for "a reply to the most recent message in this conversation", and on a thread
 * longer than its cap it was handing over the twelve oldest — so the model never
 * saw the message it was answering. Hence the inner query orders descending to
 * choose, and the outer one restores reading order for the prompt.
 */
export function listThreadMessages(
  accountId: string,
  threadId: string,
  limit = 30
): ThreadContextMessage[] {
  const rows = getRawSqlite()
    .prepare(
      `SELECT * FROM (
         SELECT id, from_addr, to_addr, subject, date, body_text, body_html
         FROM messages
         WHERE account_id = ? AND COALESCE(thread_id, id) = ?
         GROUP BY COALESCE(message_id, id)
         ORDER BY date DESC, id DESC
         LIMIT ?
       ) ORDER BY date, id`
    )
    .all(accountId, threadId, limit) as Array<{
    id: string
    from_addr: string
    to_addr: string
    subject: string
    date: number
    body_text: string | null
    body_html: string | null
  }>

  return rows.map((r) => ({
    id: r.id,
    from: r.from_addr,
    to: r.to_addr,
    subject: r.subject,
    date: r.date,
    bodyText: r.body_text,
    bodyHtml: r.body_html
  }))
}

export interface ThreadFingerprint {
  /** Distinct messages in the conversation, counted as listThreadMessages counts. */
  messageCount: number
  /** The newest message's id, or null for a conversation with no messages. */
  latestMessageId: string | null
}

/**
 * A cheap identity for what a conversation currently contains.
 *
 * Computed the same way when a summary is stored and when it is read back, so
 * the two cannot drift apart by construction. Never derive the stored value from
 * the messages actually sent to the model: those are capped and windowed, so a
 * long thread would look like a short one and every read would report stale.
 *
 * Counts *distinct* messages — `COALESCE(message_id, id)`, matching
 * `listThreadMessages` — or a Gmail conversation would appear to change size
 * every time a label was added.
 *
 * The `id` tiebreak on the newest message is load-bearing: two messages can
 * share a timestamp, and without it the fingerprint is nondeterministic, so a
 * fresh summary reports itself stale at random.
 */
export function getThreadFingerprint(accountId: string, threadKey: string): ThreadFingerprint {
  const raw = getRawSqlite()
  const counted = raw
    .prepare(
      `SELECT COUNT(DISTINCT COALESCE(message_id, id)) AS n
       FROM messages WHERE account_id = ? AND COALESCE(thread_id, id) = ?`
    )
    .get(accountId, threadKey) as { n: number }
  // Identified by Message-ID, not row id, for the same reason the count is:
  // Gmail stores one email once per label, so the newest *row* changes when a
  // label is added even though the conversation has not. Keying on the row id
  // made starring a message flip its summary to stale.
  const newest = raw
    .prepare(
      `SELECT COALESCE(message_id, id) AS mid FROM messages
       WHERE account_id = ? AND COALESCE(thread_id, id) = ?
       ORDER BY date DESC, mid DESC LIMIT 1`
    )
    .get(accountId, threadKey) as { mid: string } | undefined

  return { messageCount: counted.n, latestMessageId: newest?.mid ?? null }
}

export interface ThreadAnalysisRow {
  json: string
  generatedAt: number
  messageCount: number
  analyzedCount: number
  latestMessageId: string
}

export function getThreadAnalysis(
  accountId: string,
  threadKey: string
): ThreadAnalysisRow | null {
  const row = getRawSqlite()
    .prepare(
      `SELECT json, generated_at, message_count, analyzed_count, latest_message_id
       FROM thread_analysis WHERE account_id = ? AND thread_id = ?`
    )
    .get(accountId, threadKey) as
    | {
        json: string
        generated_at: number
        message_count: number
        analyzed_count: number
        latest_message_id: string
      }
    | undefined
  if (!row) return null
  return {
    json: row.json,
    generatedAt: row.generated_at,
    messageCount: row.message_count,
    analyzedCount: row.analyzed_count,
    latestMessageId: row.latest_message_id
  }
}

/** Upsert: re-summarizing a conversation replaces its row rather than adding one. */
export function setThreadAnalysis(
  accountId: string,
  threadKey: string,
  row: ThreadAnalysisRow
): void {
  getRawSqlite()
    .prepare(
      `INSERT INTO thread_analysis
         (account_id, thread_id, json, generated_at, message_count, analyzed_count, latest_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, thread_id) DO UPDATE SET
         json = excluded.json,
         generated_at = excluded.generated_at,
         message_count = excluded.message_count,
         analyzed_count = excluded.analyzed_count,
         latest_message_id = excluded.latest_message_id`
    )
    .run(
      accountId,
      threadKey,
      row.json,
      row.generatedAt,
      row.messageCount,
      row.analyzedCount,
      row.latestMessageId
    )
}

export function deleteThreadAnalysis(accountId: string, threadKey: string): void {
  getRawSqlite()
    .prepare('DELETE FROM thread_analysis WHERE account_id = ? AND thread_id = ?')
    .run(accountId, threadKey)
}

/**
 * Drop cached summaries whose conversation no longer exists.
 *
 * A thread key is derived, so it can *stop existing*: `regroupThreadsForAccount`
 * re-links conversations after every sync that ingests mail, and a late reply
 * bridging two threads collapses them onto one key. The loser's row is then
 * orphaned rather than stale — nothing will ever ask for it again, and it holds
 * mail-derived text indefinitely. No foreign key can express this, because
 * `thread_id` keys no table.
 *
 * Deliberately a prune and not an adoption: after a merge the surviving
 * conversation is a *different, larger* one, and a summary written about a
 * subset of it was never an answer about it. The staleness check catches the
 * survivor anyway.
 */
export function pruneOrphanedThreadAnalysis(accountId: string): number {
  const raw = getRawSqlite()
  // Almost every account has never used the feature; one indexed probe keeps the
  // common case off the full-account scan below.
  const any = raw
    .prepare('SELECT 1 FROM thread_analysis WHERE account_id = ? LIMIT 1')
    .get(accountId)
  if (!any) return 0

  const result = raw
    .prepare(
      `DELETE FROM thread_analysis
       WHERE account_id = ?
         AND thread_id NOT IN (
           SELECT DISTINCT COALESCE(thread_id, id) FROM messages WHERE account_id = ?
         )`
    )
    .run(accountId, accountId)
  return result.changes
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

// CONDSTORE MODSEQ is a 64-bit value kept as a string to avoid precision loss.
export function getFolderHighestModseq(folderId: string): string | null {
  const db = getDb()
  const folder = db
    .select({ highestModseq: folders.highestModseq })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get()
  return folder?.highestModseq ?? null
}

export function setFolderHighestModseq(folderId: string, modseq: string): void {
  const db = getDb()
  db.update(folders).set({ highestModseq: modseq }).where(eq(folders.id, folderId)).run()
}

// Last-seen server message count (STATUS MESSAGES); a drop signals an expunge.
export function getFolderServerCount(folderId: string): number | null {
  const db = getDb()
  const folder = db
    .select({ serverMessageCount: folders.serverMessageCount })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get()
  return folder?.serverMessageCount ?? null
}

export function setFolderServerCount(folderId: string, count: number): void {
  const db = getDb()
  db.update(folders).set({ serverMessageCount: count }).where(eq(folders.id, folderId)).run()
}

// Remove local rows for messages expunged on the server. Folder-scoped, so the
// same Message-ID's copies under other folders (Gmail labels) are untouched.
// Uses deleteMessage per row to reuse attachment-file cleanup + FTS + unread
// recount; returns the number removed.
export function deleteMessagesByUid(folderId: string, uids: number[]): number {
  if (uids.length === 0) return 0
  const db = getDb()
  const wanted = new Set(uids)
  const rows = db
    .select({ id: messages.id, uid: messages.uid })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .all()
  const doomed = rows.filter((r) => wanted.has(r.uid)).map((r) => r.id)
  deleteMessages(doomed)
  return doomed.length
}

// Reconcile server flags into local rows: for the given folder, set is_read /
// is_starred for the listed UIDs, but only where they actually changed (so we
// don't churn writes or clobber the app-local flag_color). Clearing a star also
// clears flag_color, mirroring setMessageStarred. Returns the number changed.
export function applyFlagUpdates(
  folderId: string,
  updates: { uid: number; isRead: boolean; isStarred: boolean }[]
): number {
  if (updates.length === 0) return 0
  const db = getDb()

  // Current flag state for the whole folder, keyed by uid (one query — avoids
  // inArray variable limits on large folders).
  const current = db
    .select({
      uid: messages.uid,
      isRead: messages.isRead,
      isStarred: messages.isStarred
    })
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .all()
  const byUid = new Map(current.map((c) => [c.uid, c]))

  let changed = 0
  db.transaction(() => {
    for (const u of updates) {
      const cur = byUid.get(u.uid)
      if (!cur) continue // UID not synced locally
      if (cur.isRead === u.isRead && cur.isStarred === u.isStarred) continue
      const patch: Partial<typeof messages.$inferInsert> = {
        isRead: u.isRead,
        isStarred: u.isStarred
      }
      if (!u.isStarred && cur.isStarred) patch.flagColor = null
      db.update(messages)
        .set(patch)
        .where(and(eq(messages.folderId, folderId), eq(messages.uid, u.uid)))
        .run()
      changed++
    }
  })

  if (changed > 0) recalculateFolderUnread(folderId)
  return changed
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
  const sqlite = getRawSqlite()

  // Same ordering rule as deleteMessages: rows first, then the files they
  // referenced, so a crash cannot leave a row pointing at a file that is gone.
  const filePaths = (
    sqlite
      .prepare(
        `SELECT a.local_path FROM attachments a
         JOIN messages m ON m.id = a.message_id
         WHERE m.folder_id = ? AND a.local_path IS NOT NULL`
      )
      .all(folderId) as Array<{ local_path: string }>
  ).map((r) => r.local_path)

  db.delete(messages).where(eq(messages.folderId, folderId)).run()

  for (const path of filePaths) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // Row already gone; an unremovable file is wasted space, not a bug.
    }
  }
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

/**
 * POP3 message identity, by the protocol's own UIDL rather than our 32-bit hash
 * of it. The hash collides — ~1% at 10k messages — and a collision made a new
 * message look already-synced, or pointed a delete at the wrong message.
 */
export function getFolderServerUidSet(folderId: string): Set<string> {
  const rows = getRawSqlite()
    .prepare('SELECT server_uid FROM messages WHERE folder_id = ? AND server_uid IS NOT NULL')
    .all(folderId) as Array<{ server_uid: string }>
  return new Set(rows.map((r) => r.server_uid))
}

/**
 * POP3 messages already known to fall outside the sync window, as UIDL → date.
 *
 * A message outside the window is never stored, so nothing in `messages` records
 * that it was looked at — without this the poll re-read its headers every 20s,
 * forever, for every old message in the maildrop.
 *
 * The stored value is the message's own date, not a "skipped" marker, so a wider
 * sync window brings it back into range with nothing to invalidate.
 */
export function getPop3SkippedDates(accountId: string): Map<string, number> {
  const rows = getRawSqlite()
    .prepare('SELECT server_uid, message_date FROM pop3_skipped WHERE account_id = ?')
    .all(accountId) as Array<{ server_uid: string; message_date: number }>
  return new Map(rows.map((r) => [r.server_uid, r.message_date]))
}

/** Remember that this UIDL is dated outside the window. Idempotent per UIDL. */
export function recordPop3Skipped(
  accountId: string,
  serverUid: string,
  messageDate: number
): void {
  getRawSqlite()
    .prepare(
      `INSERT INTO pop3_skipped (account_id, server_uid, message_date) VALUES (?, ?, ?)
       ON CONFLICT(account_id, server_uid) DO UPDATE SET message_date = excluded.message_date`
    )
    .run(accountId, serverUid, messageDate)
}

/**
 * Drop remembered UIDLs the maildrop no longer lists.
 *
 * Without this the table only ever grows: mail deleted on the server (by another
 * client, or by a POP3 client that does not leave copies) would be remembered
 * forever. Called with the *full* UIDL listing, not the batch, or it would forget
 * everything outside the batch on every poll and re-read it all next time.
 */
export function prunePop3Skipped(accountId: string, presentUids: Set<string>): number {
  const raw = getRawSqlite()
  const known = raw
    .prepare('SELECT server_uid FROM pop3_skipped WHERE account_id = ?')
    .all(accountId) as Array<{ server_uid: string }>
  const gone = known.map((r) => r.server_uid).filter((uid) => !presentUids.has(uid))
  if (gone.length === 0) return 0
  const remove = raw.prepare('DELETE FROM pop3_skipped WHERE account_id = ? AND server_uid = ?')
  const removeAll = raw.transaction((uids: string[]) => {
    for (const uid of uids) remove.run(accountId, uid)
  })
  removeAll(gone)
  return gone.length
}

/**
 * Every stored copy of the given messages, across the folders of their own
 * account.
 *
 * A Gmail label *is* an IMAP folder, and a message carrying three labels is
 * synced as three rows sharing one `message_id`. That is the whole basis of
 * label editing: the labels a message carries are the folders its copies sit
 * in, adding one is a COPY into that folder, and removing one is an expunge of
 * that copy. Thread listing already dedupes these rows for display; this is the
 * same relationship read the other way, on purpose.
 *
 * Keyed by `COALESCE(message_id, id)` — the same key the dedupe uses — so a
 * message that arrived without a Message-ID header groups with nothing but
 * itself rather than with every other header-less message. The join is scoped
 * to the account: two accounts that both hold a message have two independent
 * sets of labels, and crossing them would offer to put one account's label on
 * the other's copy.
 */
export interface MessageCopy {
  /** The row's own id — what a delete or an expunge needs. */
  id: string
  /** The message it is a copy of, as passed in. */
  requestedId: string
  folderId: string
  accountId: string
  uid: number
}

export function listMessageCopies(messageIds: string[]): MessageCopy[] {
  if (messageIds.length === 0) return []
  const placeholders = messageIds.map(() => '?').join(', ')
  // `seed` is the rows asked about; `copies` is every row of the same account
  // sharing a seed's key. A seed is its own copy, which is what makes "this
  // message is in Inbox" fall out without a special case.
  const rows = getRawSqlite()
    .prepare(
      `WITH seed AS (
         SELECT id, account_id, COALESCE(message_id, id) AS mkey
         FROM messages WHERE id IN (${placeholders})
       )
       SELECT c.id AS id, s.id AS requested_id, c.folder_id AS folder_id,
              c.account_id AS account_id, c.uid AS uid
       FROM seed s
       JOIN messages c
         ON c.account_id = s.account_id
        AND COALESCE(c.message_id, c.id) = s.mkey`
    )
    .all(...messageIds) as {
    id: string
    requested_id: string
    folder_id: string
    account_id: string
    uid: number
  }[]

  return rows.map((r) => ({
    id: r.id,
    requestedId: r.requested_id,
    folderId: r.folder_id,
    accountId: r.account_id,
    uid: r.uid
  }))
}

/** The UIDL a POP3 message was stored under, for a server-side delete. */
export function getMessageServerUid(messageId: string): string | null {
  const row = getRawSqlite()
    .prepare('SELECT server_uid FROM messages WHERE id = ?')
    .get(messageId) as { server_uid: string | null } | undefined
  return row?.server_uid ?? null
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
  /** POP3 only: the UIDL string, the protocol's real message identity. */
  serverUid?: string | null
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

  // Plain-text projection for search — computed here so every writer gets it.
  const searchText = messageSearchableBody(data.bodyText, data.bodyHtml)

  if (existing) {
    db.update(messages)
      .set({
        messageId: data.messageId,
        serverUid: data.serverUid ?? null,
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
        bodyText: data.bodyText,
        searchText
      })
      .where(eq(messages.id, id))
      .run()
  } else {
    db.insert(messages).values({
      id,
      folderId: data.folderId,
      accountId: data.accountId,
      uid: data.uid,
      serverUid: data.serverUid ?? null,
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
      bodyText: data.bodyText,
      searchText
    }).run()
  }

  // Collect the participants for compose autocomplete — new messages only, so
  // re-syncing a folder (which re-upserts every row) doesn't inflate the counts
  // that decide ranking. Never let this fail a sync: a malformed header is not
  // a reason to lose the message.
  if (isNew) {
    try {
      const accountEmail = getAccountEmailCached(data.accountId)
      if (accountEmail) {
        harvestContacts({
          accountId: data.accountId,
          accountEmail,
          from: data.from,
          to: data.to,
          cc: data.cc,
          date: data.date
        })
      }
    } catch (err) {
      console.warn('[orbit-mail] contact harvest failed:', err)
    }
  }

  return { id, isNew }
}

// Account addresses, memoized — harvest needs one per message and they never
// change for an existing account. A miss falls through to the DB, so an account
// added after the cache warmed is still found.
const accountEmailCache = new Map<string, string>()

function getAccountEmailCached(accountId: string): string | null {
  const cached = accountEmailCache.get(accountId)
  if (cached !== undefined) return cached
  const row = getDb()
    .select({ email: accounts.email })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get()
  if (!row) return null
  accountEmailCache.set(accountId, row.email)
  return row.email
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
  // Blocked mail is not shown, so it must not be counted either — an unread
  // badge for messages the user cannot see is the most confusing possible
  // outcome, and it feeds the tray icon and the window title too.
  const row = db
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        eq(messages.folderId, folderId),
        eq(messages.isRead, false),
        blockedDrizzleCondition(blockedFor(folderId))
      )
    )
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

export function countMessages(folderId: string | 'unified', unreadOnly = false): number {
  const db = getDb()

  let scope
  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return 0
    scope = inArray(messages.folderId, inboxIds)
  } else {
    scope = eq(messages.folderId, folderId)
  }

  // Must carry the same predicate as listMessages, or the header count and the
  // rows on screen disagree and infinite scroll mis-computes its offsets.
  const row = db
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        unreadOnly ? and(scope, eq(messages.isRead, false)) : scope,
        blockedDrizzleCondition(blockedFor(folderId))
      )
    )
    .get()
  const draftAccount = unreadOnly ? null : draftsFolderAccount(folderId)
  return (row?.value ?? 0) + (draftAccount ? countDrafts(draftAccount) : 0)
}

export function deleteMessage(messageId: string): void {
  deleteMessages([messageId])
}

/**
 * Delete messages and their cached attachment files.
 *
 * Three things this gets right that deleting row-by-row did not:
 *
 * - **The rows go in one transaction.** A crash part way through a prune or an
 *   expunge reconcile used to leave the batch half applied.
 * - **Files are unlinked *after* the rows are gone**, not before. The old order
 *   meant a crash in between left rows pointing at files that no longer existed
 *   — an attachment the reader offers and cannot open. This way the same crash
 *   leaves files with no rows: wasted bytes, invisible, and reclaimable. Of the
 *   two failure modes that is plainly the better one.
 * - **Unread counts are recomputed once per affected folder**, rather than once
 *   per row — pruning 5,000 messages from one folder did 5,000 recounts.
 */
export function deleteMessages(messageIds: string[]): number {
  if (messageIds.length === 0) return 0
  const db = getDb()
  const sqlite = getRawSqlite()

  // Collected before the delete: the attachment rows cascade with the messages.
  const folderIds = new Set<string>()
  const filePaths: string[] = []
  const present: string[] = []
  for (const id of messageIds) {
    const row = db
      .select({ folderId: messages.folderId })
      .from(messages)
      .where(eq(messages.id, id))
      .get()
    if (!row) continue
    present.push(id)
    folderIds.add(row.folderId)
    for (const att of db
      .select({ localPath: attachments.localPath })
      .from(attachments)
      .where(eq(attachments.messageId, id))
      .all()) {
      if (att.localPath) filePaths.push(att.localPath)
    }
  }

  const removeRows = sqlite.transaction((ids: string[]) => {
    for (const id of ids) {
      db.delete(messages).where(eq(messages.id, id)).run()
    }
  })
  removeRows(present)

  for (const path of filePaths) {
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // The row is already gone; a file we cannot remove is wasted space, not
      // a correctness problem.
    }
  }

  for (const folderId of folderIds) recalculateFolderUnread(folderId)
  return present.length
}


export function addAttachment(
  messageId: string,
  filename: string,
  mimeType: string,
  size: number,
  localPath: string | null,
  isInline = false
): string {
  const db = getDb()
  const id = randomUUID()
  db.insert(attachments).values({
    id,
    messageId,
    filename,
    mimeType,
    size,
    localPath,
    isInline
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

  deleteMessages(stale.map((row) => row.id))

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

export function listMessageAttachments(messageId: string) {
  const db = getDb()
  return db.select().from(attachments).where(eq(attachments.messageId, messageId)).all()
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

// Columns each search scope matches against. 'all' spans sender, recipient,
// subject and body. Search is a substring LIKE over the messages table — no
// full-text index is involved (see search-index.ts) — which is correct for
// every scope, matches mid-word, and is fast at cache sizes.
// Metadata columns each scope matches against. The message body is handled
// separately (see searchMessages) because it searches the plain-text
// search_text column, with a fallback to raw body_html for rows the background
// backfill has not reached yet.
const SEARCH_META_COLUMNS: Record<SearchField, string[]> = {
  all: ['m.from_addr', 'm.to_addr', 'm.subject', 'm.snippet'],
  from: ['m.from_addr'],
  to: ['m.to_addr'],
  subject: ['m.subject'],
  body: []
}
const SEARCH_FIELDS_WITH_BODY: ReadonlySet<SearchField> = new Set<SearchField>(['all', 'body'])
const SEARCH_LIMIT_MAX = 200

/**
 * Search the local cache.
 *
 * `accountId` of **null** searches every account — what the unified inbox needs.
 * It used to be required, which is why "All Inboxes" had its search box
 * disabled: the view you would naturally live in was the one view you could not
 * search from.
 */
export function searchMessages(
  text: string,
  accountId: string | null,
  field: SearchField = 'all',
  limit = 50
): MessageSummary[] {
  const sqlite = getRawSqlite()
  const likePattern = buildLikePattern(text)
  // An empty-string accountId is a caller bug, not a request to search
  // everything — only an explicit null means that.
  if (!likePattern || accountId === '') return []

  // `limit` crosses the IPC boundary from the renderer; clamp it so a bad value
  // cannot ask the main process to marshal an unbounded result set.
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit) || 50), SEARCH_LIMIT_MAX)

  const clauses = (SEARCH_META_COLUMNS[field] ?? SEARCH_META_COLUMNS.all).map(
    (col) => `${col} LIKE ? COLLATE NOCASE ESCAPE '\\'`
  )
  const args: unknown[] = accountId === null ? [] : [accountId]
  args.push(...clauses.map(() => likePattern))

  if (SEARCH_FIELDS_WITH_BODY.has(field)) {
    // search_text is the stripped plain-text body (~10x smaller than raw HTML
    // and free of markup false-matches). For rows the backfill has not reached,
    // search_text is NULL, so fall back to body_text/body_html for those — once
    // the backfill completes, only search_text is ever scanned.
    clauses.push(
      `(COALESCE(m.search_text, m.body_text) LIKE ? COLLATE NOCASE ESCAPE '\\'` +
        ` OR (m.search_text IS NULL AND m.body_html LIKE ? COLLATE NOCASE ESCAPE '\\'))`
    )
    args.push(likePattern, likePattern)
  }
  // Search spans folders, so it uses the whole blocklist rather than a
  // folder-scoped one. Without this, blocked mail stays perfectly findable and
  // "blocked" would mean only "not in the list I was looking at".
  const block = blockedSqlFragment(getBlockedSenders().slice(0, MAX_BLOCKED_PREDICATES), 'm.from_addr')
  args.push(...block.params, safeLimit)

  // Unified search drops the account predicate rather than looping per account:
  // one query, one ORDER BY, one LIMIT — so the newest N across all accounts is
  // what comes back, not the newest N of each merged and re-truncated.
  const scope = accountId === null ? '' : 'm.account_id = ? AND '

  const rows = sqlite
    .prepare(
      `${SEARCH_SELECT}
       FROM messages m
       WHERE ${scope}(${clauses.join(' OR ')})${block.clause}
       ORDER BY m.date DESC
       LIMIT ?`
    )
    .all(...args) as SearchRow[]

  return mapSearchRows(rows)
}

// Populate search_text for one batch of rows that lack it (old mail synced
// before the column existed). Returns rows processed; 0 when none remain, so a
// caller can loop until drained. New/updated messages get search_text on upsert,
// so this only ever drains the historical backlog.
export function backfillSearchTextBatch(batchSize = 250): number {
  const sqlite = getRawSqlite()
  const rows = sqlite
    .prepare('SELECT id, body_text, body_html FROM messages WHERE search_text IS NULL LIMIT ?')
    .all(batchSize) as Array<{ id: string; body_text: string | null; body_html: string | null }>
  if (rows.length === 0) return 0

  const update = sqlite.prepare('UPDATE messages SET search_text = ? WHERE id = ?')
  const run = sqlite.transaction((batch: typeof rows) => {
    for (const r of batch) update.run(messageSearchableBody(r.body_text, r.body_html), r.id)
  })
  run(rows)
  return rows.length
}

// Load specific messages as summaries, newest first. Used by the server-side
// search fallback to return exactly the rows it just imported, preserving the
// server's match (which may be a From/To hit that local search doesn't cover).
export function getMessageSummariesByIds(ids: string[]): MessageSummary[] {
  if (ids.length === 0) return []
  const sqlite = getRawSqlite()
  const placeholders = ids.map(() => '?').join(',')
  const rows = sqlite
    .prepare(`${SEARCH_SELECT} FROM messages m WHERE m.id IN (${placeholders}) ORDER BY m.date DESC`)
    .all(...ids) as SearchRow[]
  return mapSearchRows(rows)
}
