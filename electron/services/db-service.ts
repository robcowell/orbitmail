import { randomUUID } from 'crypto'
import { eq, desc, and, inArray, max, count } from 'drizzle-orm'
import { getDb, getRawSqlite, upsertFts, deleteFts } from '../db'
import { accounts, folders, messages, attachments } from '../db/schema'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  FolderType,
  Provider,
  FlagColor
} from '../../shared/types'
import {
  encryptCredentials,
  decryptCredentials,
  type TokenData,
  type ManualAccountCredentials,
  type AccountCredentials
} from './account-credentials'

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
      displayName: tokenData.displayName
    }
  }

  const id = randomUUID()
  const account: Account = {
    id,
    provider,
    email: tokenData.email,
    displayName: tokenData.displayName
  }
  db.insert(accounts).values({
    id,
    provider,
    email: tokenData.email,
    displayName: tokenData.displayName,
    tokenBlob: encryptCredentials({ authType: 'oauth', ...tokenData }),
    createdAt: Date.now()
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
      displayName: creds.displayName
    }
  }

  const id = randomUUID()
  db.insert(accounts).values({
    id,
    provider,
    email: creds.email,
    displayName: creds.displayName,
    tokenBlob: encryptCredentials(creds),
    createdAt: Date.now()
  }).run()

  return {
    id,
    provider,
    email: creds.email,
    displayName: creds.displayName
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
    displayName: r.displayName
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
    createdAt: row.createdAt
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
    displayName: row.displayName
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
  const db = getDb()
  db.delete(accounts).where(eq(accounts.id, accountId)).run()
}

export function upsertFolder(
  accountId: string,
  imapPath: string,
  name: string,
  type: FolderType
): Folder {
  const db = getDb()
  const existing = db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.imapPath, imapPath)))
    .get()

  if (existing) {
    return {
      id: existing.id,
      accountId: existing.accountId,
      imapPath: existing.imapPath,
      name: existing.name,
      type: existing.type as FolderType,
      unreadCount: existing.unreadCount
    }
  }

  const id = randomUUID()
  db.insert(folders).values({
    id,
    accountId,
    imapPath,
    name,
    type,
    unreadCount: 0
  }).run()

  return { id, accountId, imapPath, name, type, unreadCount: 0 }
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
    unreadCount: r.unreadCount
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
    unreadCount: r.unreadCount
  }
}

export function getInboxFolderIds(): string[] {
  const db = getDb()
  return db.select({ id: folders.id }).from(folders).where(eq(folders.type, 'inbox')).all().map((r) => r.id)
}

function rowToSummary(r: typeof messages.$inferSelect): MessageSummary {
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
    hasAttachments: r.hasAttachments
  }
}

export function listMessages(
  folderId: string | 'unified',
  limit = 200,
  offset = 0
): MessageSummary[] {
  const db = getDb()
  let rows: (typeof messages.$inferSelect)[]

  if (folderId === 'unified') {
    const inboxIds = getInboxFolderIds()
    if (inboxIds.length === 0) return []
    rows = db
      .select()
      .from(messages)
      .where(inArray(messages.folderId, inboxIds))
      .orderBy(desc(messages.date))
      .limit(limit)
      .offset(offset)
      .all()
  } else {
    rows = db
      .select()
      .from(messages)
      .where(eq(messages.folderId, folderId))
      .orderBy(desc(messages.date))
      .limit(limit)
      .offset(offset)
      .all()
  }

  return rows.map(rowToSummary)
}

export function getMessage(messageId: string): MessageDetail | null {
  const db = getDb()
  const r = db.select().from(messages).where(eq(messages.id, messageId)).get()
  if (!r) return null
  const atts = db.select().from(attachments).where(eq(attachments.messageId, messageId)).all()
  return {
    ...rowToSummary(r),
    cc: r.cc ?? '',
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

export function upsertMessage(data: {
  folderId: string
  accountId: string
  uid: number
  messageId?: string
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
}): { id: string; isNew: boolean } {
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

  upsertFts(id, data.subject, data.snippet, data.bodyText ?? '')
  return { id, isNew }
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
    .select({ folderId: messages.folderId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  if (!existing) return

  db.update(messages).set({ isRead }).where(eq(messages.id, messageId)).run()
  recalculateFolderUnread(existing.folderId)
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
    return db
      .select()
      .from(messages)
      .where(inArray(messages.folderId, inboxIds))
      .all().length
  }

  return db
    .select()
    .from(messages)
    .where(eq(messages.folderId, folderId))
    .all().length
}

export function deleteMessage(messageId: string): void {
  const db = getDb()
  const existing = db
    .select({ folderId: messages.folderId })
    .from(messages)
    .where(eq(messages.id, messageId))
    .get()
  deleteFts(messageId)
  db.delete(messages).where(eq(messages.id, messageId)).run()
  if (existing) {
    recalculateFolderUnread(existing.folderId)
  }
}

export function addAttachment(
  messageId: string,
  filename: string,
  mimeType: string,
  size: number,
  localPath: string
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

export function getAttachment(attachmentId: string) {
  const db = getDb()
  return db.select().from(attachments).where(eq(attachments.id, attachmentId)).get()
}

export function searchMessages(text: string, limit = 50): MessageSummary[] {
  const sqlite = getRawSqlite()
  const query = text.replace(/[^\w\s@.]/g, ' ').trim()
  if (!query) return []

  const rows = sqlite
    .prepare(
      `SELECT m.id, m.folder_id, m.account_id, m.uid, m.message_id,
              m.from_addr, m.to_addr, m.subject, m.snippet, m.date,
              m.is_read, m.is_starred, m.flag_color, m.has_attachments
       FROM messages_fts fts
       JOIN messages m ON m.id = fts.message_id
       WHERE messages_fts MATCH ?
       ORDER BY rank
       LIMIT ?`
    )
    .all(query + '*', limit) as Array<{
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
  }>

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
    hasAttachments: Boolean(r.has_attachments)
  }))
}
