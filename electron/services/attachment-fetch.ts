import { writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Attachment as ParsedAttachment } from 'mailparser'
import { simpleParser } from 'mailparser'
import Pop3Command from 'node-pop3'
import { getAttachmentsDir } from '../db'
import {
  addAttachment,
  getAttachment,
  getFolderById,
  getManualCredentials,
  getMessageSyncContext,
  updateAttachmentLocalPath
} from './db-service'
import { createImapClient } from './imap-sync'
import { pop3ClientOptions } from './account-credentials'

function safeAttachmentName(filename: string | undefined, uid: number): string {
  return (filename ?? `attachment-${uid}`).replace(/[^\w.-]/g, '_')
}

export function recordAttachmentsMetadata(
  messageId: string,
  parsedAttachments: ParsedAttachment[]
): void {
  for (const att of parsedAttachments) {
    addAttachment(
      messageId,
      att.filename ?? 'attachment',
      att.contentType ?? 'application/octet-stream',
      att.size ?? att.content?.length ?? 0,
      null
    )
  }
}

function findParsedAttachment(
  parsedAttachments: ParsedAttachment[] | undefined,
  filename: string,
  size: number
): ParsedAttachment | undefined {
  if (!parsedAttachments?.length) return undefined

  const exact = parsedAttachments.find(
    (att) =>
      (att.filename ?? 'attachment') === filename &&
      (att.size ?? att.content?.length ?? 0) === size
  )
  if (exact?.content) return exact

  return parsedAttachments.find(
    (att) => (att.filename ?? 'attachment') === filename && att.content
  )
}

function writeAttachmentFile(
  attachmentId: string,
  messageId: string,
  uid: number,
  filename: string,
  content: Buffer
): string {
  const dir = getAttachmentsDir()
  const safeName = safeAttachmentName(filename, uid)
  const path = join(dir, `${messageId}-${safeName}`)
  writeFileSync(path, content)
  updateAttachmentLocalPath(attachmentId, path)
  return path
}

async function downloadAttachmentFromImap(
  attachmentId: string,
  att: { filename: string; size: number; messageId: string }
): Promise<string> {
  const context = getMessageSyncContext(att.messageId)
  if (!context) throw new Error('Message not found')

  const folder = getFolderById(context.folderId)
  if (!folder) throw new Error('Folder not found')

  const client = await createImapClient(context.accountId, context.provider)
  try {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      const msg = await client.fetchOne(
        context.uid.toString(),
        { source: true },
        { uid: true }
      )
      if (!msg?.source) throw new Error('Message not found on server')

      const parsed = await simpleParser(msg.source)
      const match = findParsedAttachment(parsed.attachments, att.filename, att.size)
      if (!match?.content) throw new Error('Attachment not found on server')

      return writeAttachmentFile(
        attachmentId,
        att.messageId,
        context.uid,
        att.filename,
        match.content
      )
    } finally {
      lock.release()
    }
  } finally {
    await client.logout()
  }
}

function hashUid(serverUid: string, msgNum: number): number {
  let hash = 0
  const input = `${serverUid}:${msgNum}`
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash || msgNum
}

async function downloadAttachmentFromPop3(
  attachmentId: string,
  att: { filename: string; size: number; messageId: string }
): Promise<string> {
  const context = getMessageSyncContext(att.messageId)
  if (!context) throw new Error('Message not found')

  const creds = getManualCredentials(context.accountId)
  if (!creds) throw new Error('Account credentials not found')

  const pop3 = new Pop3Command(
    pop3ClientOptions(creds.incoming, creds.username, creds.password)
  )

  try {
    const uidl = await pop3.UIDL()
    let msgNum: number | null = null

    for (const [msgNumStr, serverUid] of uidl ?? []) {
      if (hashUid(serverUid, Number(msgNumStr)) === context.uid) {
        msgNum = Number(msgNumStr)
        break
      }
    }

    if (msgNum == null) throw new Error('Message not found on server')

    const raw = await pop3.RETR(msgNum)
    if (!raw) throw new Error('Message not found on server')

    const parsed = await simpleParser(raw)
    const match = findParsedAttachment(parsed.attachments, att.filename, att.size)
    if (!match?.content) throw new Error('Attachment not found on server')

    return writeAttachmentFile(
      attachmentId,
      att.messageId,
      context.uid,
      att.filename,
      match.content
    )
  } finally {
    await pop3.QUIT().catch(() => {})
  }
}

export async function ensureAttachmentLocal(attachmentId: string): Promise<string> {
  const att = getAttachment(attachmentId)
  if (!att) throw new Error('Attachment not found')
  if (att.localPath && existsSync(att.localPath)) return att.localPath

  const context = getMessageSyncContext(att.messageId)
  if (!context) throw new Error('Message not found')

  if (context.provider === 'pop3') {
    return downloadAttachmentFromPop3(attachmentId, att)
  }

  return downloadAttachmentFromImap(attachmentId, att)
}
