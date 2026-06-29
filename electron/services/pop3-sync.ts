import Pop3Command from 'node-pop3'
import { simpleParser } from 'mailparser'
import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  getManualCredentials,
  upsertFolder,
  upsertMessage,
  recalculateFolderUnread,
  addAttachment,
  getFolderUidSet,
  hasMessageUid,
  getFolderMaxUid,
  updateFolderSyncState
} from './db-service'
import { pop3ClientOptions } from './account-credentials'
import { getAttachmentsDir } from '../db'
import type { SyncProgressHandler } from './imap-sync'

const SYNC_BATCH_SIZE = 200

function makeSnippet(text: string, max = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
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

function hashUid(serverUid: string, msgNum: number): number {
  let hash = 0
  const input = `${serverUid}:${msgNum}`
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash || msgNum
}

async function saveAttachments(
  messageId: string,
  uid: number,
  parsedAttachments: import('mailparser').Attachment[]
): Promise<void> {
  const dir = getAttachmentsDir()
  for (const att of parsedAttachments) {
    if (!att.content) continue
    const safeName = (att.filename ?? `attachment-${uid}`).replace(/[^\w.-]/g, '_')
    const path = join(dir, `${messageId}-${safeName}`)
    writeFileSync(path, att.content)
    addAttachment(
      messageId,
      att.filename ?? safeName,
      att.contentType ?? 'application/octet-stream',
      att.size ?? att.content.length,
      path
    )
  }
}

function createPop3Client(accountId: string): Pop3Command {
  const creds = getManualCredentials(accountId)
  if (!creds) throw new Error('Account credentials not found')
  return new Pop3Command(pop3ClientOptions(creds.incoming, creds.username, creds.password))
}

function parsePop3Stat(stat: unknown): number {
  const text = Array.isArray(stat) ? String(stat[0] ?? '') : String(stat ?? '')
  return Number(text.split(/\s+/)[0] ?? 0)
}

export async function estimatePop3NewMessageCount(accountId: string): Promise<number> {
  const folder = upsertFolder(accountId, 'INBOX', 'INBOX', 'inbox')
  const knownUids = getFolderUidSet(folder.id)
  const pop3 = createPop3Client(accountId)

  try {
    const uidl = await pop3.UIDL()
    const entries = uidl ?? []
    let newCount = 0

    for (const [msgNumStr, serverUid] of entries.slice(-SYNC_BATCH_SIZE)) {
      const uid = hashUid(serverUid, Number(msgNumStr))
      if (!knownUids.has(uid)) newCount++
    }

    return newCount
  } finally {
    await pop3.QUIT().catch(() => {})
  }
}

export async function syncPop3Account(
  accountId: string,
  onProgress?: SyncProgressHandler
): Promise<number> {
  const pop3 = createPop3Client(accountId)
  const folder = upsertFolder(accountId, 'INBOX', 'INBOX', 'inbox')
  let newCount = 0

  try {
    const uidl = await pop3.UIDL()
    const entries = uidl ?? []
    const batch = entries.slice(-SYNC_BATCH_SIZE)

    for (const [msgNumStr, serverUid] of batch) {
      const msgNum = Number(msgNumStr)
      const uid = hashUid(serverUid, msgNum)
      if (hasMessageUid(folder.id, uid)) continue

      const raw = await pop3.RETR(msgNum)
      if (!raw) continue

      const parsed = await simpleParser(raw)
      const from = formatAddress(parsed.from?.value[0])
      const to = formatAddressList(parsed.to?.value)
      const cc = formatAddressList(parsed.cc?.value)
      const subject = parsed.subject ?? '(No subject)'
      const bodyText = parsed.text ?? ''
      const bodyHtml = parsed.html ? String(parsed.html) : null
      const snippet = makeSnippet(bodyText || (parsed.textAsHtml ?? subject))
      const date = parsed.date?.getTime() ?? Date.now()

      const { id, isNew } = upsertMessage({
        folderId: folder.id,
        accountId,
        uid,
        messageId: parsed.messageId,
        from,
        to,
        cc,
        subject,
        snippet,
        date,
        isRead: false,
        isStarred: false,
        hasAttachments: (parsed.attachments?.length ?? 0) > 0,
        bodyHtml,
        bodyText
      })

      if (!isNew) continue

      if (parsed.attachments?.length) {
        await saveAttachments(id, uid, parsed.attachments)
      }

      newCount++
      onProgress?.()
    }

    recalculateFolderUnread(folder.id)

    const highestSyncedUid = getFolderMaxUid(folder.id) ?? 0
    updateFolderSyncState(folder.id, {
      highestSyncedUid,
      lastSyncAt: Date.now(),
      initialSyncComplete: highestSyncedUid > 0 || batch.length > 0
    })
  } finally {
    await pop3.QUIT().catch(() => {})
  }

  return newCount
}

export async function deletePop3MessageOnServer(
  accountId: string,
  uid: number
): Promise<void> {
  const pop3 = createPop3Client(accountId)
  try {
    const uidl = await pop3.UIDL()
    for (const [msgNumStr, serverUid] of uidl ?? []) {
      const msgNum = Number(msgNumStr)
      if (hashUid(serverUid, msgNum) === uid) {
        await pop3.DELE(msgNum)
        break
      }
    }
  } finally {
    await pop3.QUIT().catch(() => {})
  }
}

export async function testPop3Connection(accountId: string): Promise<void> {
  const pop3 = createPop3Client(accountId)
  try {
    await pop3.STAT()
  } finally {
    await pop3.QUIT().catch(() => {})
  }
}
