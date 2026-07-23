import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type {
  Provider,
  FolderType,
  SyncStatus,
  MessageSummary,
  SearchField
} from '../../shared/types'
import { getAttachmentsDir } from '../db'
import {
  getAccountTokens,
  getManualCredentials,
  updateAccountTokens,
  upsertFolder,
  upsertMessagesBatch,
  updateFolderUnread,
  listAccounts,
  getAccountById,
  getMessageSummariesByIds,
  getMessage,
  getFolderById,
  getFolderMaxUid,
  getFolderUidValidity,
  updateFolderSyncState,
  clearFolderMessages,
  getFolderUidSet,
  recalculateFolderUnread,
  countMessages,
  type UpsertMessageData,
  getAccountSyncDays,
  regroupThreadsForAccount,
  pruneMessagesOutsideSyncWindow,
  listFolders,
  getFolderHighestModseq,
  setFolderHighestModseq,
  getFolderServerCount,
  setFolderServerCount,
  applyFlagUpdates,
  deleteMessagesByUid,
  type TokenData
} from './db-service'
import type { Folder } from '../../shared/types'
import { getLastSyncAt, setLastSyncAt } from './preferences-service'
import { recordAttachmentsMetadata, toAttachmentMeta, type AttachmentMeta } from './attachment-fetch'
import { isWithinSyncWindow, syncSinceDate } from './sync-policy'
import { isVirtualViewFolder } from '../../shared/folders'
import { imapConnectionSecurity } from './account-credentials'
import { refreshGoogleToken, resolveGoogleAccessToken, formatGmailAuthError } from './oauth-google'
import { refreshMicrosoftToken } from './oauth-microsoft'
import {
  estimatePop3NewMessageCount,
  syncPop3Account,
  deletePop3MessageOnServer
} from './pop3-sync'
import { withImapClient } from './imap-pool'
import { computeThreadId, normalizeReferences } from './thread-util'

// POP3 accounts have no IDLE, so they poll frequently. IMAP/Gmail/O365 inboxes
// are push-synced by IMAP IDLE, so those accounts poll on a slower cadence as a
// safety net (IDLE drops, non-inbox folder changes) rather than every 20s.
const POLL_INTERVAL_MS = 20_000
const IDLE_ACCOUNT_POLL_INTERVAL_MS = 90_000
// Flag reconciliation is background and non-urgent; run it on a gentle cadence.
const FLAG_RECONCILE_INTERVAL_MS = 300_000

const PROVIDER_CONFIG: Record<
  'gmail' | 'o365',
  { imap: { host: string; port: number }; smtp: { host: string; port: number } }
> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993 },
    smtp: { host: 'smtp.gmail.com', port: 587 }
  },
  o365: {
    imap: { host: 'outlook.office365.com', port: 993 },
    smtp: { host: 'smtp.office365.com', port: 587 }
  }
}

const SPECIAL_USE_MAP: Record<string, FolderType> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'sent',
  '\\Drafts': 'drafts',
  '\\Trash': 'trash',
  '\\Junk': 'junk'
}

const FOLDER_NAME_MAP: Record<string, FolderType> = {
  INBOX: 'inbox',
  'Sent Mail': 'sent',
  'Sent Items': 'sent',
  Sent: 'sent',
  Drafts: 'drafts',
  Trash: 'trash',
  Deleted: 'trash',
  'Deleted Items': 'trash',
  // Gmail's localized Trash in en-GB accounts. Servers that advertise
  // SPECIAL-USE flag it \Trash and never reach this map, but not all do.
  Bin: 'trash',
  Junk: 'junk',
  Spam: 'junk'
}

export type SyncStatusState = SyncStatus

let syncStatus: SyncStatusState = {
  syncing: false,
  lastSyncAt: null,
  error: null,
  syncCurrent: 0,
  syncTotal: 0
}

export function initSyncFromPersistence(): void {
  syncStatus = {
    ...syncStatus,
    lastSyncAt: getLastSyncAt()
  }
}

let statusListeners: ((s: SyncStatusState) => void)[] = []
let pollInterval: ReturnType<typeof setInterval> | null = null
let idlePollInterval: ReturnType<typeof setInterval> | null = null
let flagReconcileInterval: ReturnType<typeof setInterval> | null = null

// Per-account Sent-folder path, so appendToSentFolder doesn't LIST on every send.
const sentPathCache = new Map<string, string>()

export type SyncProgressHandler = () => void

export function getSyncStatus(): SyncStatusState {
  return { ...syncStatus }
}

export function onSyncStatusChange(listener: (s: SyncStatusState) => void): () => void {
  statusListeners.push(listener)
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener)
  }
}

function setSyncStatus(patch: Partial<SyncStatusState>): void {
  syncStatus = { ...syncStatus, ...patch }
  if (patch.lastSyncAt !== undefined) {
    setLastSyncAt(patch.lastSyncAt)
  }
  statusListeners.forEach((l) => l({ ...syncStatus }))
}

function incrementSyncProgress(by = 1): void {
  const syncCurrent = syncStatus.syncCurrent + by
  setSyncStatus({
    syncCurrent,
    syncTotal: Math.max(syncStatus.syncTotal, syncCurrent)
  })
}

const SYNC_BATCH_SIZE = 200
// Ceiling on how much history a UIDVALIDITY resync will rebuild. Bounds the
// work when a very large folder resets; anything beyond this is treated the
// same way the app treats history it has never cached.
const UIDVALIDITY_RESYNC_MAX_MESSAGES = 2000

/** ImapFlow exposes UID fields as bigint; normalize before compare/store. */
function normalizeImapUint(value: unknown): number | null {
  if (value == null) return null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function estimateNewMessagesInFolder(maxLocalUid: number | null, uidNext: number): number {
  const highestUid = Math.max(0, uidNext - 1)
  if (maxLocalUid == null) {
    return Math.min(SYNC_BATCH_SIZE, highestUid)
  }
  if (uidNext <= maxLocalUid + 1) return 0
  return highestUid - maxLocalUid
}

async function countNewMessagesForAccount(
  accountId: string,
  provider: Provider
): Promise<number> {
  if (provider === 'pop3') {
    return estimatePop3NewMessageCount(accountId)
  }

  return withImapClient(accountId, provider, async (client) => {
    let total = 0
    const mailboxes = await client.list()
    const folderTypes = detectFolderTypes(mailboxes)
    for (const mb of mailboxes) {
      if (mb.flags?.has('\\Noselect')) continue
      const folder = upsertFolder(
        accountId,
        mb.path,
        mb.name,
        folderTypes.get(mb.path) ?? 'custom',
        isVirtualViewFolder(provider, mb.path)
      )
      const status = await client.status(mb.path, { uidNext: true, uidValidity: true })
      const storedValidity = normalizeImapUint(getFolderUidValidity(folder.id))
      const serverValidity = normalizeImapUint(status.uidValidity)
      const uidNext = normalizeImapUint(status.uidNext) ?? 1
      const highestUid = Math.max(0, uidNext - 1)

      if (
        storedValidity != null &&
        serverValidity != null &&
        storedValidity !== serverValidity
      ) {
        // Folder will be re-synced from scratch; initial batch can exceed incremental estimate.
        total += Math.min(SYNC_BATCH_SIZE, highestUid)
      } else {
        total += estimateNewMessagesInFolder(getFolderMaxUid(folder.id), uidNext)
      }
    }
    return total
  })
}

async function ensureFreshToken(
  accountId: string,
  provider: Provider,
  tokens: TokenData
): Promise<TokenData> {
  const needsRefresh =
    !tokens.expiryDate || tokens.expiryDate < Date.now() + 120000

  if (!needsRefresh) return tokens

  let refreshed: TokenData
  if (provider === 'gmail' && tokens.refreshToken) {
    refreshed = await refreshGoogleToken(tokens)
  } else if (provider === 'o365') {
    refreshed = await refreshMicrosoftToken(tokens)
  } else {
    return tokens
  }

  updateAccountTokens(accountId, refreshed)
  return refreshed
}

export async function createImapClient(
  accountId: string,
  provider: Provider
): Promise<ImapFlow> {
  if (provider === 'pop3') {
    throw new Error('POP3 accounts do not use IMAP')
  }

  const manual = provider === 'imap' ? getManualCredentials(accountId) : null

  if (manual) {
    const client = new ImapFlow({
      host: manual.incoming.host,
      port: manual.incoming.port,
      ...imapConnectionSecurity(manual.incoming.security),
      auth: {
        user: manual.username,
        pass: manual.password
      },
      logger: false
    })
    await client.connect()
    return client
  }

  const stored = getAccountTokens(accountId)
  if (!stored) throw new Error('Account tokens not found')

  let email = stored.email
  let accessToken = stored.accessToken

  try {
    if (provider === 'gmail') {
      const resolved = await resolveGoogleAccessToken(accountId, stored)
      accessToken = resolved.accessToken
      email = resolved.tokenData.email
    } else {
      const tokens = await ensureFreshToken(accountId, provider, stored)
      accessToken = tokens.accessToken
      email = tokens.email
    }
  } catch (err) {
    if (provider === 'gmail') {
      throw formatGmailAuthError(err, email)
    }
    throw err
  }

  const config = PROVIDER_CONFIG[provider as 'gmail' | 'o365']

  const client = new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: true,
    auth: {
      user: email,
      accessToken
    },
    logger: false
  })

  try {
    await client.connect()
  } catch (err) {
    if (provider === 'gmail') {
      throw formatGmailAuthError(err, email)
    }
    throw err
  }

  return client
}

function folderSyncRank(mb: {
  name: string
  path: string
  specialUse?: string | string[] | null
}): number {
  const priority = ['\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk']
  const specialIdx = priority.findIndex((p) => mb.specialUse?.includes(p))
  if (specialIdx !== -1) return specialIdx

  if (mb.path === 'INBOX' || mb.name === 'INBOX') return 0

  const type = detectFolderType(mb.name, mb.specialUse)
  const typeRank: Record<FolderType, number> = {
    inbox: 0,
    sent: 1,
    drafts: 2,
    trash: 3,
    junk: 4,
    custom: 100
  }
  return typeRank[type]
}

function sortMailboxesForSync<
  T extends { name: string; path: string; specialUse?: string[]; flags?: Set<string> }
>(mailboxes: T[]): T[] {
  return [...mailboxes].sort((a, b) => {
    const diff = folderSyncRank(a) - folderSyncRank(b)
    if (diff !== 0) return diff
    return a.name.localeCompare(b.name)
  })
}

async function getRecentMessageUids(
  client: ImapFlow,
  batchSize: number,
  syncDays: number
): Promise<number[]> {
  const since = syncSinceDate(syncDays)

  if (since) {
    try {
      const sorted = await client.sort(['REVERSE DATE'], { since }, { uid: true })
      if (sorted?.length) {
        return sorted
          .slice(0, batchSize)
          .map((uid) => normalizeImapUint(uid))
          .filter((uid): uid is number => uid != null)
      }
    } catch {
      // SORT unsupported for this query
    }

    try {
      const found = await client.search({ since }, { uid: true })
      if (found?.length) {
        const uids = found
          .map((uid) => normalizeImapUint(uid))
          .filter((uid): uid is number => uid != null)
        return uids.length > batchSize ? uids.slice(-batchSize) : uids
      }
    } catch {
      // fall through to legacy fetch
    }
  }

  let uids: unknown[] = []

  try {
    const sorted = await client.sort(['REVERSE DATE'], ['ALL'], { uid: true })
    if (sorted?.length) {
      uids = sorted.slice(0, batchSize)
    }
  } catch {
    // SORT not supported — fall back to SEARCH
  }

  if (uids.length === 0) {
    const all = await client.search({ all: true }, { uid: true })
    if (!all?.length) return []
    uids = all.length > batchSize ? all.slice(-batchSize) : all
  }

  return uids
    .map((uid) => normalizeImapUint(uid))
    .filter((uid): uid is number => uid != null)
}

let onFolderSynced: (() => void) | null = null
let onNewMailArrived: ((count: number) => void) | null = null

export function setOnFolderSynced(callback: (() => void) | null): void {
  onFolderSynced = callback
}

export function setOnNewMailArrived(callback: ((count: number) => void) | null): void {
  onNewMailArrived = callback
}

async function resolveUidsToFetch(
  client: ImapFlow,
  folderId: string,
  accountId: string,
  maxLocalUid: number | null,
  uidNext: number
): Promise<number[]> {
  if (maxLocalUid != null && uidNext <= maxLocalUid + 1) {
    return []
  }

  const syncDays = getAccountSyncDays(accountId)
  let candidates: number[]
  if (maxLocalUid == null) {
    candidates = await getRecentMessageUids(client, SYNC_BATCH_SIZE, syncDays)
  } else {
    const found = (await client.search({ uid: `${maxLocalUid + 1}:*` }, { uid: true })) ?? []
    candidates = found
      .map((uid) => normalizeImapUint(uid))
      .filter((uid): uid is number => uid != null)
  }

  const existing = getFolderUidSet(folderId)
  return candidates.filter((uid) => !existing.has(uid))
}

export function findInboxMailbox<
  T extends { name: string; path: string; specialUse?: string[]; flags?: Set<string> }
>(mailboxes: T[]): T | undefined {
  return mailboxes.find(
    (mb) =>
      !mb.flags?.has('\\Noselect') &&
      (mb.path === 'INBOX' ||
        mb.name === 'INBOX' ||
        mb.specialUse?.includes('\\Inbox'))
  )
}

// imapflow gives `specialUse` as a *single string* ("\\Trash"), not an array —
// iterating it as one walked the characters, so `SPECIAL_USE_MAP` never matched
// and every folder was typed from its English name. That is why Gmail's
// localized Bin ([Gmail]/Bin, flagged \Trash) was typed `custom` while a legacy
// user folder called "Deleted Items" claimed `trash`, and deletes went to a
// plain label instead of the real Trash. Accepts either shape now.
export function detectFolderType(
  name: string,
  specialUse?: string | string[] | null
): FolderType {
  for (const flag of specialUseFlags(specialUse)) {
    const mapped = SPECIAL_USE_MAP[flag]
    if (mapped) return mapped
  }
  return FOLDER_NAME_MAP[name] ?? 'custom'
}

function specialUseFlags(specialUse?: string | string[] | null): string[] {
  if (!specialUse) return []
  const raw = Array.isArray(specialUse) ? specialUse : [specialUse]
  // Flags are case-insensitive in IMAP; normalize to the map's capitalization.
  return raw
    .filter((flag): flag is string => typeof flag === 'string' && flag.length > 0)
    .map((flag) => {
      const key = Object.keys(SPECIAL_USE_MAP).find(
        (candidate) => candidate.toLowerCase() === flag.trim().toLowerCase()
      )
      return key ?? flag.trim()
    })
}

interface TypedMailbox {
  name: string
  path: string
  specialUse?: string | string[] | null
}

// Type every mailbox in one pass so SPECIAL-USE can outrank a name guess.
// Without this, an account carrying both a server-flagged Trash and an old user
// folder named "Deleted Items" has two `trash` folders and whichever comes first
// wins the delete destination. A server that states its special-use is
// authoritative; the name map is only a fallback for servers that do not.
export function detectFolderTypes<T extends TypedMailbox>(
  mailboxes: T[]
): Map<string, FolderType> {
  const types = new Map<string, FolderType>()
  const flagged = new Map<FolderType, string>()

  for (const mb of mailboxes) {
    const fromFlags = specialUseFlags(mb.specialUse)
      .map((flag) => SPECIAL_USE_MAP[flag])
      .find((mapped): mapped is FolderType => !!mapped)
    types.set(mb.path, fromFlags ?? FOLDER_NAME_MAP[mb.name] ?? 'custom')
    if (fromFlags && !flagged.has(fromFlags)) flagged.set(fromFlags, mb.path)
  }

  // Demote name-derived matches for any role the server flagged elsewhere.
  for (const mb of mailboxes) {
    const type = types.get(mb.path)
    if (!type || type === 'custom') continue
    const owner = flagged.get(type)
    if (owner && owner !== mb.path) types.set(mb.path, 'custom')
  }

  return types
}

function formatAddress(addr: { address?: string; name?: string } | undefined): string {
  if (!addr) return ''
  if (addr.name) return `${addr.name} <${addr.address}>`
  return addr.address ?? ''
}

function formatAddressList(
  addrs: { address?: string; name?: string }[] | undefined
): string {
  if (!addrs?.length) return ''
  return addrs.map((a) => formatAddress(a)).join(', ')
}

function makeSnippet(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

async function fetchMessagesByUid(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  uids: number[],
  onProgress?: SyncProgressHandler,
  // ignoreWindow: fetch matches even if older than the sync window. Used by the
  // server-side search fallback, which must surface mail outside the local cache.
  options: { ignoreWindow?: boolean } = {}
): Promise<{ newCount: number; maxUid: number | null; ids: string[] }> {
  if (uids.length === 0) return { newCount: 0, maxUid: null, ids: [] }

  const syncDays = getAccountSyncDays(accountId)
  let maxUid: number | null = null

  // Parse (async, per-message) into a buffer first, then commit the whole batch
  // in one transaction so a folder's fetch is a single WAL commit rather than one
  // per message. Only attachment *metadata* is kept here, not the parsed content
  // Buffers — those are re-fetched on open, and retaining a whole folder's worth
  // across the batch was gigabytes for large attachments (they are never used).
  const pending: { data: UpsertMessageData; attachments: AttachmentMeta[] }[] = []

  for await (const msg of client.fetch(
    uids.join(','),
    {
      uid: true,
      envelope: true,
      flags: true,
      source: true
    },
    { uid: true }
  )) {
    if (!msg.source) continue

    const uid = normalizeImapUint(msg.uid)
    if (uid == null) continue

    maxUid = maxUid == null ? uid : Math.max(maxUid, uid)

    const parsed = await simpleParser(msg.source)
    const from = formatAddress(parsed.from?.value[0])
    const to = formatAddressList(parsed.to?.value)
    const cc = formatAddressList(parsed.cc?.value)
    const subject = parsed.subject ?? '(No subject)'
    const bodyText = parsed.text ?? ''
    const bodyHtml = parsed.html ? String(parsed.html) : null
    const snippet = makeSnippet(bodyText || (parsed.textAsHtml ?? subject))
    const date = parsed.date?.getTime() ?? Date.now()
    if (!options.ignoreWindow && !isWithinSyncWindow(date, syncDays)) continue

    const isRead = msg.flags?.has('\\Seen') ?? false
    const isStarred = msg.flags?.has('\\Flagged') ?? false
    const hasAttachments = (parsed.attachments?.length ?? 0) > 0
    const inReplyTo = normalizeReferences(parsed.inReplyTo)
    const references = normalizeReferences(parsed.references)
    const threadId = computeThreadId({
      messageId: parsed.messageId,
      inReplyTo,
      references,
      subject
    })

    pending.push({
      data: {
        folderId,
        accountId,
        uid,
        messageId: parsed.messageId,
        inReplyTo,
        references,
        threadId,
        from,
        to,
        cc,
        subject,
        snippet,
        date,
        isRead,
        isStarred,
        hasAttachments,
        bodyHtml,
        bodyText
      },
      attachments: (parsed.attachments ?? []).map(toAttachmentMeta)
    })
  }

  const results = upsertMessagesBatch(pending.map((p) => p.data))

  let newCount = 0
  results.forEach((res, i) => {
    if (!res.isNew) return
    const atts = pending[i].attachments
    if (atts.length) recordAttachmentsMetadata(res.id, atts)
    newCount++
    onProgress?.()
  })

  return { newCount, maxUid, ids: results.map((r) => r.id) }
}

const SERVER_SEARCH_LIMIT = 50

// Pick a single folder that best represents "the whole mailbox" for a live
// server search: Gmail's All Mail holds one copy of every message; otherwise
// fall back to the INBOX.
function pickServerSearchFolder(accountId: string): Folder | null {
  const all = listFolders(accountId).filter((f) => !f.isVirtualView)
  const allMail = all.find((f) => /(^|\/)All Mail$/i.test(f.imapPath))
  if (allMail) return allMail
  return all.find((f) => f.type === 'inbox' || f.imapPath.toUpperCase() === 'INBOX') ?? null
}

// Translate a search scope into a server query. Gmail uses its raw operators;
// standard IMAP uses the matching SEARCH keys. 'all' spans From/To/Subject/Body.
function buildServerSearchQuery(field: SearchField, query: string, provider: Provider) {
  if (provider === 'gmail') {
    // Gmail has no body-only operator, so 'body' (and 'all') use a plain term,
    // which matches everywhere including the body.
    const op: Partial<Record<SearchField, string>> = {
      from: 'from:',
      to: 'to:',
      subject: 'subject:'
    }
    return { gmraw: op[field] ? `${op[field]}(${query})` : query }
  }

  switch (field) {
    case 'from':
      return { from: query }
    case 'to':
      return { to: query }
    case 'subject':
      return { subject: query }
    case 'body':
      return { body: query }
    default:
      return { or: [{ from: query }, { to: query }, { subject: query }, { body: query }] }
  }
}

// Live IMAP search fallback: when the local cache has no match, query the server
// directly, import the matches into the DB (so they become openable rows), and
// return them as summaries. POP3 has no server-side search, so it returns [].
export async function searchServerMessages(
  text: string,
  accountId: string,
  field: SearchField = 'all'
): Promise<MessageSummary[]> {
  const query = text.trim()
  if (!query) return []

  const account = getAccountById(accountId)
  if (!account || account.provider === 'pop3') return []

  const folder = pickServerSearchFolder(accountId)
  if (!folder) return []

  const searchQuery = buildServerSearchQuery(field, query, account.provider)

  return withImapClient(accountId, account.provider, async (client) => {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      const found = (await client.search(searchQuery, { uid: true })) ?? []
      const uids = found
        .map((uid) => normalizeImapUint(uid))
        .filter((uid): uid is number => uid != null)
        .sort((a, b) => b - a)
        .slice(0, SERVER_SEARCH_LIMIT)
      if (uids.length === 0) return []

      const { ids } = await fetchMessagesByUid(client, accountId, folder.id, uids, undefined, {
        ignoreWindow: true
      })
      return getMessageSummariesByIds(ids)
    } finally {
      lock.release()
    }
  })
}

// A UIDVALIDITY change means every cached UID for the folder is meaningless, so
// the local rows have to go. Two things make the naive "wipe, then fetch one
// batch" version lossy:
//
//  - `resolveUidsToFetch` filters candidates against the *stale* local UID set,
//    so any new message whose UID collides with an old row is skipped — and
//    then the old row is deleted, losing the message entirely. Server UIDs
//    frequently restart low after a validity reset, so collisions are likely.
//  - One batch is `SYNC_BATCH_SIZE` messages. A folder that had accumulated
//    thousands of cached messages would keep 200.
//
// So: resolve the restore set directly from the server (no stale filtering),
// sized to what we had, then wipe and refill in batches. The wipe still
// precedes the refill — upserting new mail while stale rows hold the same
// (folder_id, uid) would collide — but `clearFolderMessages` resets
// highestSyncedUid/initialSyncComplete and `uidValidity` is only written after
// a successful refill, so an interrupted resync is retried from scratch on the
// next pass rather than leaving the folder permanently empty.
async function resyncAfterUidValidityChange(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  imapPath: string,
  onProgress?: SyncProgressHandler
): Promise<{ newCount: number; maxUid: number | null } | null> {
  const previousCount = countMessages(folderId)
  const restoreTarget = Math.min(
    Math.max(SYNC_BATCH_SIZE, previousCount),
    UIDVALIDITY_RESYNC_MAX_MESSAGES
  )

  const uids = await getRecentMessageUids(client, restoreTarget, getAccountSyncDays(accountId))

  if (uids.length === 0) {
    console.warn(
      `[orbit-mail] UIDVALIDITY changed for ${imapPath} but no UIDs to fetch; keeping local cache`
    )
    return null
  }

  console.warn(
    `[orbit-mail] UIDVALIDITY changed for ${imapPath}; rebuilding ${uids.length} of ${previousCount} cached messages`
  )
  clearFolderMessages(folderId)

  let newCount = 0
  let maxUid: number | null = null

  for (let i = 0; i < uids.length; i += SYNC_BATCH_SIZE) {
    const batch = await fetchMessagesByUid(
      client,
      accountId,
      folderId,
      uids.slice(i, i + SYNC_BATCH_SIZE),
      onProgress
    )
    newCount += batch.newCount
    if (batch.maxUid != null) {
      maxUid = maxUid == null ? batch.maxUid : Math.max(maxUid, batch.maxUid)
    }
  }

  recalculateFolderUnread(folderId)
  return { newCount, maxUid }
}

export async function syncFolder(
  client: ImapFlow,
  accountId: string,
  folderId: string,
  imapPath: string,
  onProgress?: SyncProgressHandler
): Promise<number> {
  const status = await client.status(imapPath, {
    uidNext: true,
    unseen: true,
    uidValidity: true
  })

  const storedValidity = normalizeImapUint(getFolderUidValidity(folderId))
  const serverValidity = normalizeImapUint(status.uidValidity)
  const validityChanged =
    storedValidity != null &&
    serverValidity != null &&
    storedValidity !== serverValidity

  let maxLocalUid = validityChanged ? null : getFolderMaxUid(folderId)
  const uidNext = normalizeImapUint(status.uidNext) ?? 1

  if (maxLocalUid != null && uidNext <= maxLocalUid + 1) {
    updateFolderUnread(folderId, status.unseen ?? 0)
    updateFolderSyncState(folderId, {
      uidValidity: serverValidity,
      lastSyncAt: Date.now()
    })
    return 0
  }

  const lock = await client.getMailboxLock(imapPath)
  try {
    if (validityChanged) {
      const resynced = await resyncAfterUidValidityChange(
        client,
        accountId,
        folderId,
        imapPath,
        onProgress
      )
      if (!resynced) return 0

      updateFolderSyncState(folderId, {
        uidValidity: serverValidity,
        highestSyncedUid: resynced.maxUid ?? 0,
        lastSyncAt: Date.now(),
        initialSyncComplete: (resynced.maxUid ?? 0) > 0
      })
      return resynced.newCount
    }

    const uids = await resolveUidsToFetch(client, folderId, accountId, maxLocalUid, uidNext)

    const { newCount, maxUid } = await fetchMessagesByUid(
      client,
      accountId,
      folderId,
      uids,
      onProgress
    )

    recalculateFolderUnread(folderId)

    const highestSyncedUid = Math.max(maxLocalUid ?? 0, maxUid ?? 0)
    updateFolderSyncState(folderId, {
      uidValidity: serverValidity,
      highestSyncedUid,
      lastSyncAt: Date.now(),
      initialSyncComplete: highestSyncedUid > 0
    })

    return newCount
  } finally {
    lock.release()
  }
}

export async function syncAccount(
  accountId: string,
  provider: Provider,
  options: { onProgress?: SyncProgressHandler; silent?: boolean } = {}
): Promise<number> {
  if (provider === 'pop3') {
    const newCount = await syncPop3Account(accountId, options.onProgress ?? incrementSyncProgress)
    if (newCount > 0) {
      regroupThreadsForAccount(accountId)
      onFolderSynced?.()
    }
    return newCount
  }

  // The pooled client serializes per-account operations, so two syncs of the
  // same account queue rather than colliding; different accounts run in parallel.
  const newCount = await withImapClient(accountId, provider, async (client) => {
    let synced = 0
    const mailboxes = await client.list()
    const folderMap: Record<string, string> = {}
    const folderTypes = detectFolderTypes(mailboxes)

    for (const mb of mailboxes) {
      if (mb.flags?.has('\\Noselect')) continue
      const type = folderTypes.get(mb.path) ?? 'custom'
      const folder = upsertFolder(
        accountId,
        mb.path,
        mb.name,
        type,
        isVirtualViewFolder(provider, mb.path)
      )
      folderMap[mb.path] = folder.id
    }

    for (const mb of sortMailboxesForSync(mailboxes)) {
      if (mb.flags?.has('\\Noselect')) continue
      const folderId = folderMap[mb.path]
      if (!folderId) continue

      const fetched = await syncFolder(client, accountId, folderId, mb.path, options.onProgress)
      if (fetched > 0) {
        synced += fetched
        onFolderSynced?.()
      }
    }
    return synced
  })

  // New mail can bridge previously-separate threads, so re-link the account's
  // conversations whenever anything was fetched.
  if (newCount > 0) regroupThreadsForAccount(accountId)

  pruneMessagesOutsideSyncWindow(accountId, getAccountSyncDays(accountId))
  return newCount
}

function accountSyncError(email: string, err: unknown): string {
  return err instanceof Error ? err.message : `Sync failed for ${email}`
}

export async function refreshAccount(accountId: string, provider: Provider): Promise<void> {
  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: 0
  })

  try {
    const total = await countNewMessagesForAccount(accountId, provider)
    setSyncStatus({ syncTotal: Math.max(total, 1) })

    const fetched = await syncAccount(accountId, provider, {
      onProgress: incrementSyncProgress
    })

    setSyncStatus({
      syncing: false,
      lastSyncAt: Date.now(),
      error: null,
      syncCurrent: fetched,
      syncTotal: Math.max(fetched, total, 1)
    })

    if (fetched > 0) {
      onFolderSynced?.()
    }

    // A manual refresh should also pull server flag changes (read/star).
    void reconcileAccountFlags(accountId, provider).catch(() => {})
  } catch (err) {
    const message = accountSyncError(
      getAccountTokens(accountId)?.email ?? accountId,
      err
    )
    setSyncStatus({ syncing: false, error: message })
    throw err instanceof Error ? err : new Error(message)
  }
}

export async function refreshAllAccounts(): Promise<void> {
  if (syncStatus.syncing) return

  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: 0
  })

  const accounts = listAccounts()
  const errors: string[] = []

  // Accounts sync independently through their own pooled connections, so run
  // them in parallel rather than one-at-a-time.
  const estimates = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await countNewMessagesForAccount(account.id, account.provider)
      } catch (err) {
        errors.push(accountSyncError(account.email, err))
        return 0
      }
    })
  )
  const estimatedTotal = estimates.reduce((sum, n) => sum + n, 0)

  setSyncStatus({ syncTotal: Math.max(estimatedTotal, 1) })

  const fetchedCounts = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await syncAccount(account.id, account.provider, {
          onProgress: incrementSyncProgress
        })
      } catch (err) {
        errors.push(accountSyncError(account.email, err))
        return 0
      }
    })
  )
  const fetchedTotal = fetchedCounts.reduce((sum, n) => sum + n, 0)

  setSyncStatus({
    syncing: false,
    lastSyncAt: Date.now(),
    error: errors.length ? errors.join('\n\n') : null,
    syncCurrent: fetchedTotal,
    syncTotal: Math.max(fetchedTotal, estimatedTotal, 1)
  })

  if (fetchedTotal > 0) {
    onFolderSynced?.()
  }

  // Also reconcile server flag changes on a manual refresh-all.
  void reconcileAllAccountsFlags({ filter: (a) => a.provider !== 'pop3' })

  if (errors.length === accounts.length && accounts.length > 0) {
    throw new Error(errors.join('\n\n'))
  }
}

export async function pollForNewMessages(
  options: { announce?: boolean; filter?: (account: { provider: Provider }) => boolean } = {}
): Promise<void> {
  const announce = options.announce ?? true
  if (syncStatus.syncing) return

  const accounts = options.filter ? listAccounts().filter(options.filter) : listAccounts()
  if (accounts.length === 0) return

  const estimates = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await countNewMessagesForAccount(account.id, account.provider)
      } catch {
        // polling should not surface transient errors in the UI
        return 0
      }
    })
  )
  const estimatedTotal = estimates.reduce((sum, n) => sum + n, 0)

  if (estimatedTotal === 0) {
    setSyncStatus({ lastSyncAt: Date.now() })
    return
  }

  setSyncStatus({
    syncing: true,
    error: null,
    syncCurrent: 0,
    syncTotal: estimatedTotal
  })

  const fetchedCounts = await Promise.all(
    accounts.map(async (account) => {
      try {
        return await syncAccount(account.id, account.provider, {
          onProgress: incrementSyncProgress,
          silent: true
        })
      } catch {
        // keep polling on the next interval
        return 0
      }
    })
  )
  const fetchedTotal = fetchedCounts.reduce((sum, n) => sum + n, 0)

  setSyncStatus({
    syncing: false,
    lastSyncAt: Date.now(),
    syncCurrent: fetchedTotal,
    syncTotal: Math.max(fetchedTotal, estimatedTotal)
  })

  if (fetchedTotal > 0) {
    onFolderSynced?.()
    // Suppress the "new mail" notification for user-initiated moves/copies —
    // re-syncing a moved message into its destination folder (e.g. Trash) is not
    // newly-arrived mail.
    if (announce) onNewMailArrived?.(fetchedTotal)
  }
}

// ---------------------------------------------------------------------------
// Flag reconciliation. Incremental sync only fetches new UIDs, so \Seen /
// \Flagged changes made on the server to already-synced messages never reach the
// local DB. This pass reconciles them: cheaply via CONDSTORE (CHANGEDSINCE) when
// the folder's MODSEQ advanced, else a flags-only full scan (also the first-run
// path that corrects existing staleness, and the non-CONDSTORE fallback). It
// downloads flags only — never message bodies.
// ---------------------------------------------------------------------------

async function reconcileFolderFlags(
  client: ImapFlow,
  folder: Folder,
  condstore: boolean
): Promise<number> {
  const status = await client.status(folder.imapPath, {
    highestModseq: true,
    uidValidity: true,
    messages: true
  })

  // If UIDVALIDITY changed, the folder is about to be re-synced from scratch —
  // let syncFolder own that; don't reconcile against a stale local set.
  const storedValidity = normalizeImapUint(getFolderUidValidity(folder.id))
  const serverValidity = normalizeImapUint(status.uidValidity)
  if (storedValidity != null && serverValidity != null && storedValidity !== serverValidity) {
    return 0
  }

  const serverModseq = status.highestModseq ?? null // bigint | null
  const stored = getFolderHighestModseq(folder.id)
  const useCondstore = condstore && serverModseq != null
  const flagsUnchanged = useCondstore && stored != null && serverModseq! <= BigInt(stored)

  // Expunge is not reliably tied to MODSEQ (RFC 7162), so gate it on the server
  // message count dropping since we last looked.
  const serverCount = status.messages ?? null
  const storedCount = getFolderServerCount(folder.id)
  const maybeExpunged = storedCount != null && serverCount != null && serverCount < storedCount

  // Nothing to do: flags unchanged AND no drop in the message count. Refresh the
  // count baseline (it may have grown) and return without taking a lock.
  if (flagsUnchanged && !maybeExpunged) {
    if (serverCount != null) setFolderServerCount(folder.id, serverCount)
    return 0
  }

  const localUids = getFolderUidSet(folder.id)
  if (localUids.size === 0) {
    if (serverModseq != null) setFolderHighestModseq(folder.id, String(serverModseq))
    if (serverCount != null) setFolderServerCount(folder.id, serverCount)
    return 0
  }

  const fullScan = !useCondstore || stored == null

  const lock = await client.getMailboxLock(folder.imapPath)
  try {
    const updates: { uid: number; isRead: boolean; isStarred: boolean }[] = []
    // Server UIDs still present in our synced range — collected free during a
    // full scan, else fetched with a bounded search when a drop is suspected.
    let survivors: Set<number> | null = null

    if (!flagsUnchanged) {
      if (fullScan) {
        survivors = new Set<number>()
        let maxUid = 0
        for (const uid of Array.from(localUids)) if (uid > maxUid) maxUid = uid
        for await (const msg of client.fetch(
          `1:${maxUid}`,
          { uid: true, flags: true },
          { uid: true }
        )) {
          const uid = normalizeImapUint(msg.uid)
          if (uid == null) continue
          survivors.add(uid)
          if (!localUids.has(uid)) continue
          updates.push({
            uid,
            isRead: msg.flags?.has('\\Seen') ?? false,
            isStarred: msg.flags?.has('\\Flagged') ?? false
          })
        }
      } else {
        // Incremental: server returns only messages whose flags changed.
        for await (const msg of client.fetch(
          '1:*',
          { uid: true, flags: true },
          { uid: true, changedSince: BigInt(stored!) }
        )) {
          const uid = normalizeImapUint(msg.uid)
          if (uid == null || !localUids.has(uid)) continue
          updates.push({
            uid,
            isRead: msg.flags?.has('\\Seen') ?? false,
            isStarred: msg.flags?.has('\\Flagged') ?? false
          })
        }
      }
    }

    let changed = applyFlagUpdates(folder.id, updates)

    // Expunge detection: any local UID no longer on the server was removed there.
    if (maybeExpunged && survivors == null) {
      let minUid = Infinity
      let maxUid = 0
      for (const uid of Array.from(localUids)) {
        if (uid < minUid) minUid = uid
        if (uid > maxUid) maxUid = uid
      }
      const found = await client.search({ uid: `${minUid}:${maxUid}` }, { uid: true })
      if (found !== false) {
        survivors = new Set(
          found.map((u) => normalizeImapUint(u)).filter((u): u is number => u != null)
        )
      }
    }

    if (survivors != null) {
      const expunged = Array.from(localUids).filter((uid) => !survivors!.has(uid))
      // Guard: only trust a full wipe when the server confirms the folder empty.
      const wouldWipeAll = expunged.length === localUids.size
      if (expunged.length > 0 && !(wouldWipeAll && (serverCount ?? 0) > 0)) {
        const removed = deleteMessagesByUid(folder.id, expunged)
        if (removed > 0) {
          console.log(
            `[orbit-mail] expunge: removed ${removed} message(s) from ${folder.name}`
          )
        }
        changed += removed
      }
    }

    // Persist baselines for next time (prefer the mailbox's live MODSEQ).
    const liveModseq = client.mailbox ? client.mailbox.highestModseq : undefined
    const newModseq = liveModseq ?? serverModseq ?? undefined
    if (newModseq != null) setFolderHighestModseq(folder.id, String(newModseq))
    if (serverCount != null) setFolderServerCount(folder.id, serverCount)

    return changed
  } finally {
    lock.release()
  }
}

export async function reconcileAccountFlags(
  accountId: string,
  provider: Provider
): Promise<void> {
  if (provider === 'pop3') return // POP3 has no server-side flags / CONDSTORE

  // Borrow the pooled client once per folder rather than once for the whole
  // pass. imap-pool serializes every operation for an account, so holding it
  // across the loop put user actions — mark read, star, move, delete — behind a
  // reconcile of every folder in the account. On a Gmail account with 20+
  // labels that is seconds of dead time on a click. Re-borrowing hands the lane
  // back between folders, so an interactive op waits for at most one folder.
  // The client itself is pooled, so this costs no extra connections.
  let changed = 0
  for (const folder of listFolders(accountId)) {
    try {
      changed += await withImapClient(accountId, provider, (client) =>
        reconcileFolderFlags(client, folder, client.capabilities.has('CONDSTORE'))
      )
    } catch {
      // One folder failing shouldn't abort the rest.
    }
  }

  if (changed > 0) {
    console.log(`[orbit-mail] flag reconcile: ${changed} message(s) updated for ${accountId}`)
    onFolderSynced?.()
  }
}

// Reconcile server flags for all (optionally filtered) accounts. Silent — does
// not touch the sync progress status; only updates the DB and notifies the
// renderer when something actually changed.
export async function reconcileAllAccountsFlags(
  options: { filter?: (account: { provider: Provider }) => boolean } = {}
): Promise<void> {
  const accounts = options.filter ? listAccounts().filter(options.filter) : listAccounts()
  await Promise.all(
    accounts.map((account) =>
      reconcileAccountFlags(account.id, account.provider).catch(() => {})
    )
  )
}

export function startBackgroundSync(intervalMs = POLL_INTERVAL_MS): void {
  if (pollInterval) return
  // Fast cadence for POP3 (no IDLE).
  pollInterval = setInterval(() => {
    pollForNewMessages({ filter: (a) => a.provider === 'pop3' }).catch(() => {})
  }, intervalMs)
  // Slower safety-net cadence for IDLE-capable accounts.
  idlePollInterval = setInterval(() => {
    pollForNewMessages({ filter: (a) => a.provider !== 'pop3' }).catch(() => {})
  }, IDLE_ACCOUNT_POLL_INTERVAL_MS)
  // Reconcile server flag changes (read/star) for already-synced IMAP mail.
  flagReconcileInterval = setInterval(() => {
    reconcileAllAccountsFlags({ filter: (a) => a.provider !== 'pop3' }).catch(() => {})
  }, FLAG_RECONCILE_INTERVAL_MS)
}

export function stopBackgroundSync(): void {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
  }
  if (idlePollInterval) {
    clearInterval(idlePollInterval)
    idlePollInterval = null
  }
  if (flagReconcileInterval) {
    clearInterval(flagReconcileInterval)
    flagReconcileInterval = null
  }
}

export async function markMessageReadOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number,
  isRead: boolean
): Promise<void> {
  if (provider === 'pop3') return

  await withImapClient(accountId, provider, async (client) => {
    const lock = await client.getMailboxLock(folderPath)
    try {
      if (isRead) {
        await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true })
      } else {
        await client.messageFlagsRemove({ uid }, ['\\Seen'], { uid: true })
      }
    } finally {
      lock.release()
    }
  })
}

export async function toggleMessageStarredOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number,
  isStarred: boolean
): Promise<void> {
  if (provider === 'pop3') return

  await withImapClient(accountId, provider, async (client) => {
    const lock = await client.getMailboxLock(folderPath)
    try {
      if (isStarred) {
        await client.messageFlagsAdd({ uid }, ['\\Flagged'], { uid: true })
      } else {
        await client.messageFlagsRemove({ uid }, ['\\Flagged'], { uid: true })
      }
    } finally {
      lock.release()
    }
  })
}

export async function deleteMessageOnServer(
  accountId: string,
  provider: Provider,
  folderPath: string,
  uid: number
): Promise<void> {
  if (provider === 'pop3') {
    await deletePop3MessageOnServer(accountId, uid)
    return
  }

  await withImapClient(accountId, provider, async (client) => {
    const lock = await client.getMailboxLock(folderPath)
    try {
      await client.messageDelete({ uid }, { uid: true })
    } finally {
      lock.release()
    }
  })
}

export async function copyMessageOnServer(
  accountId: string,
  provider: Provider,
  sourcePath: string,
  targetPath: string,
  uid: number
): Promise<void> {
  if (provider === 'pop3') {
    throw new Error('Copying messages is not supported for POP3 accounts')
  }

  await withImapClient(accountId, provider, async (client) => {
    const lock = await client.getMailboxLock(sourcePath)
    try {
      await client.messageCopy({ uid }, targetPath, { uid: true })
    } finally {
      lock.release()
    }
  })
}

export async function moveMessageOnServer(
  accountId: string,
  provider: Provider,
  sourcePath: string,
  targetPath: string,
  uid: number
): Promise<void> {
  if (provider === 'pop3') {
    throw new Error('Moving messages is not supported for POP3 accounts')
  }

  await withImapClient(accountId, provider, async (client) => {
    const lock = await client.getMailboxLock(sourcePath)
    try {
      await client.messageMove({ uid }, targetPath, { uid: true })
    } finally {
      lock.release()
    }
  })
}

export async function appendToSentFolder(
  accountId: string,
  provider: Provider,
  rawMessage: Buffer
): Promise<void> {
  if (provider === 'pop3') return

  await withImapClient(accountId, provider, async (client) => {
    let path = sentPathCache.get(accountId)
    if (!path) {
      const mailboxes = await client.list()
      const sentMb = mailboxes.find(
        (mb) => mb.specialUse?.includes('\\Sent') || FOLDER_NAME_MAP[mb.name] === 'sent'
      )
      path = sentMb?.path ?? 'Sent'
      sentPathCache.set(accountId, path)
    }
    try {
      await client.append(path, rawMessage, ['\\Seen'])
    } catch (err) {
      // Path may be stale (folder renamed) — drop the cache so the next send
      // re-discovers it, then surface the error.
      sentPathCache.delete(accountId)
      throw err
    }
  })
}

// Sync just the account's Sent folder — used right after sending so the new
// message appears without triggering a full multi-account resync.
export async function syncSentFolder(accountId: string, provider: Provider): Promise<void> {
  if (provider === 'pop3') return

  await withImapClient(accountId, provider, async (client) => {
    const mailboxes = await client.list()
    const sentMb = mailboxes.find(
      (mb) => mb.specialUse?.includes('\\Sent') || FOLDER_NAME_MAP[mb.name] === 'sent'
    )
    if (!sentMb || sentMb.flags?.has('\\Noselect')) return

    const folder = upsertFolder(
      accountId,
      sentMb.path,
      sentMb.name,
      detectFolderType(sentMb.name, sentMb.specialUse),
      isVirtualViewFolder(provider, sentMb.path)
    )
    await syncFolder(client, accountId, folder.id, sentMb.path)
  })
}

export function getAccountSmtpConfig(accountId: string, provider: Provider) {
  if (provider === 'imap' || provider === 'pop3') {
    const manual = getManualCredentials(accountId)
    if (!manual) throw new Error('SMTP settings not found')
    return manual.outgoing
  }
  return PROVIDER_CONFIG[provider as 'gmail' | 'o365'].smtp
}

export function getProviderSmtpConfig(provider: Provider) {
  if (provider === 'imap' || provider === 'pop3') {
    throw new Error('Use getAccountSmtpConfig for manual accounts')
  }
  return PROVIDER_CONFIG[provider].smtp
}

export async function exportMessageRawToTemp(messageId: string): Promise<string> {
  const msg = getMessage(messageId)
  if (!msg) throw new Error('Message not found')

  const folder = getFolderById(msg.folderId)
  if (!folder) throw new Error('Folder not found')

  const account = listAccounts().find((a) => a.id === msg.accountId)
  if (!account) throw new Error('Account not found')

  if (account.provider === 'pop3') {
    throw new Error('Raw message export is not supported for POP3 accounts')
  }

  return withImapClient(account.id, account.provider, async (client) => {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      let raw: Buffer | null = null
      for await (const item of client.fetch(String(msg.uid), { source: true }, { uid: true })) {
        raw = item.source ?? null
        break
      }

      if (!raw) throw new Error('Could not download message source')

      const safeName = (msg.subject || 'message').replace(/[^\w.-]+/g, '_').slice(0, 60)
      const path = join(tmpdir(), `orbit-mail-${safeName}-${Date.now()}.eml`)
      writeFileSync(path, raw)
      return path
    } finally {
      lock.release()
    }
  })
}
