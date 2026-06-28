import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import { eq, desc, and, inArray } from 'drizzle-orm'
import { getDb, getRawSqlite, upsertFts, deleteFts } from '../db'
import { accounts, folders, messages, attachments } from '../db/schema'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  FolderType,
  Provider
} from '../../shared/types'

export interface TokenData {
  accessToken: string
  refreshToken?: string
  expiryDate?: number
  email: string
  displayName: string
}

function encryptToken(data: TokenData): string {
  const json = JSON.stringify(data)
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(json).toString('base64')
  }
  return Buffer.from(json).toString('base64')
}

function decryptToken(blob: string): TokenData {
  const raw = Buffer.from(blob, 'base64')
  if (safeStorage.isEncryptionAvailable()) {
    return JSON.parse(safeStorage.decryptString(raw)) as TokenData
  }
  return JSON.parse(raw.toString('utf8')) as TokenData
}

export function saveAccount(
  provider: Provider,
  tokenData: TokenData
): Account {
  const db = getDb()
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
    tokenBlob: encryptToken(tokenData),
    createdAt: Date.now()
  }).run()
  return account
}

export function getAccountTokens(accountId: string): TokenData | null {
  const db = getDb()
  const row = db.select().from(accounts).where(eq(accounts.id, accountId)).get()
  if (!row) return null
  return decryptToken(row.tokenBlob)
}

export function updateAccountTokens(accountId: string, tokenData: TokenData): void {
  const db = getDb()
  db.update(accounts)
    .set({ tokenBlob: encryptToken(tokenData) })
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
}): string {
  const db = getDb()
  const existing = db
    .select()
    .from(messages)
    .where(and(eq(messages.folderId, data.folderId), eq(messages.uid, data.uid)))
    .get()

  const id = existing?.id ?? randomUUID()

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
  return id
}

export function setMessageRead(messageId: string, isRead: boolean): void {
  const db = getDb()
  db.update(messages).set({ isRead }).where(eq(messages.id, messageId)).run()
}

export function deleteMessage(messageId: string): void {
  const db = getDb()
  deleteFts(messageId)
  db.delete(messages).where(eq(messages.id, messageId)).run()
}

export function updateFolderUnread(folderId: string, count: number): void {
  const db = getDb()
  db.update(folders).set({ unreadCount: count }).where(eq(folders.id, folderId)).run()
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
              m.is_read, m.is_starred, m.has_attachments
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
    hasAttachments: Boolean(r.has_attachments)
  }))
}
