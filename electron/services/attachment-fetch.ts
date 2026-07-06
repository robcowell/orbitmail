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
import { withImapClient } from './imap-pool'
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

// A single leaf of an IMAP BODYSTRUCTURE that carries a downloadable part id.
interface BodyStructureNode {
  part?: string
  size?: number
  disposition?: string | null
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  childNodes?: BodyStructureNode[]
}

function collectParts(node: BodyStructureNode | undefined, acc: BodyStructureNode[]): void {
  if (!node) return
  if (node.childNodes?.length) {
    for (const child of node.childNodes) collectParts(child, acc)
    return
  }
  if (node.part) acc.push(node)
}

function partFilename(node: BodyStructureNode): string {
  return node.dispositionParameters?.filename ?? node.parameters?.name ?? ''
}

// Find the BODYSTRUCTURE part id for the requested attachment, preferring an
// exact filename+size match and falling back to filename alone.
function resolveAttachmentPart(
  structure: BodyStructureNode | undefined,
  filename: string,
  size: number
): string | null {
  const parts: BodyStructureNode[] = []
  collectParts(structure, parts)

  const exact = parts.find((p) => partFilename(p) === filename && (p.size ?? 0) === size)
  if (exact?.part) return exact.part

  const byName = parts.find((p) => partFilename(p) === filename)
  return byName?.part ?? null
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
  }
  return Buffer.concat(chunks)
}

async function downloadAttachmentFromImap(
  attachmentId: string,
  att: { filename: string; size: number; messageId: string }
): Promise<string> {
  const context = getMessageSyncContext(att.messageId)
  if (!context) throw new Error('Message not found')

  const folder = getFolderById(context.folderId)
  if (!folder) throw new Error('Folder not found')

  return withImapClient(context.accountId, context.provider, async (client) => {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      // Fast path: fetch just the BODYSTRUCTURE, locate the attachment's part,
      // and download only that part (imapflow decodes the transfer encoding).
      const meta = await client.fetchOne(
        context.uid.toString(),
        { bodyStructure: true },
        { uid: true }
      )
      const partId = meta
        ? resolveAttachmentPart(
            meta.bodyStructure as BodyStructureNode | undefined,
            att.filename,
            att.size
          )
        : null

      if (partId) {
        try {
          const { content } = await client.download(context.uid.toString(), partId, {
            uid: true
          })
          if (content) {
            const buffer = await streamToBuffer(content)
            if (buffer.length > 0) {
              return writeAttachmentFile(
                attachmentId,
                att.messageId,
                context.uid,
                att.filename,
                buffer
              )
            }
          }
        } catch {
          // Fall through to the whole-message parse below.
        }
      }

      // Fallback: download the whole message and parse out the attachment. Slower
      // but robust when BODYSTRUCTURE part resolution doesn't match.
      const msg = await client.fetchOne(context.uid.toString(), { source: true }, { uid: true })
      if (!msg || !msg.source) throw new Error('Message not found on server')

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
  })
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
