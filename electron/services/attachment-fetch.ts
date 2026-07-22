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
  listMessageAttachments,
  updateAttachmentLocalPath
} from './db-service'
import { withImapClient } from './imap-pool'
import { pop3ClientOptions } from './account-credentials'

function safeAttachmentName(filename: string | undefined, uid: number): string {
  return (filename ?? `attachment-${uid}`).replace(/[^\w.-]/g, '_')
}

// Only the metadata is persisted; the parsed attachment's `content` Buffer is
// never stored (it is re-fetched on demand when opened). Reducing to this shape
// as soon as a message is parsed lets the Buffer be GC'd, instead of being
// retained until a whole folder's batch is written — ~2GB for a folder of large
// attachments (imap-sync buffers the batch; see recordAttachmentsMetadata's
// caller there).
export interface AttachmentMeta {
  filename: string
  contentType: string
  size: number
}

export function toAttachmentMeta(att: ParsedAttachment): AttachmentMeta {
  return {
    filename: att.filename ?? 'attachment',
    contentType: att.contentType ?? 'application/octet-stream',
    size: att.size ?? att.content?.length ?? 0
  }
}

export function recordAttachmentsMetadata(
  messageId: string,
  attachments: AttachmentMeta[]
): void {
  for (const att of attachments) {
    addAttachment(messageId, att.filename, att.contentType, att.size, null)
  }
}

function findParsedAttachment(
  parsedAttachments: ParsedAttachment[] | undefined,
  filename: string,
  size: number,
  occurrence = 0
): ParsedAttachment | undefined {
  if (!parsedAttachments?.length) return undefined

  const sameName = parsedAttachments.filter(
    (att) => (att.filename ?? 'attachment') === filename && att.content
  )
  if (sameName.length <= 1) return sameName[0]

  // Several parts share the filename, so size cannot identify one either (and
  // often does not match anyway — see resolveAttachmentPart). Rows were created
  // in MIME order, so take the nth.
  const exact = sameName.filter((att) => (att.size ?? att.content?.length ?? 0) === size)
  if (exact.length === 1) return exact[0]
  return sameName[occurrence] ?? sameName[0]
}

/**
 * Which copy this is among the message's attachments sharing its filename.
 *
 * A message can legitimately carry several parts with one name. Rows are
 * inserted in MIME order by recordAttachmentsMetadata, and both the
 * BODYSTRUCTURE walk and mailparser enumerate parts in that same order, so
 * position is what identifies them.
 */
function attachmentOccurrence(messageId: string, attachmentId: string, filename: string): number {
  const sameName = listMessageAttachments(messageId).filter((a) => a.filename === filename)
  const index = sameName.findIndex((a) => a.id === attachmentId)
  return index < 0 ? 0 : index
}

function writeAttachmentFile(
  attachmentId: string,
  uid: number,
  filename: string,
  content: Buffer
): string {
  const dir = getAttachmentsDir()
  const safeName = safeAttachmentName(filename, uid)
  // Keyed by attachment id, not message id: a message can carry two parts with
  // the same filename (scanners and mail-merges do it, and inline images are
  // routinely all image001.png). Sharing a path made both rows resolve to one
  // file, so fetching the second overwrote the first and opening either showed
  // the same content. Existing rows keep whatever path they already stored.
  const path = join(dir, `${attachmentId}-${safeName}`)
  // 0600: these are someone's mail, in a directory this app creates.
  writeFileSync(path, content, { mode: 0o600 })
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
  size: number,
  occurrence = 0
): string | null {
  const parts: BodyStructureNode[] = []
  collectParts(structure, parts)

  const sameName = parts.filter((p) => partFilename(p) === filename)
  if (sameName.length === 0) return null
  if (sameName.length === 1) return sameName[0].part ?? null

  // Size is a weak identifier here: BODYSTRUCTURE reports encoded octets while
  // the stored size is mailparser's decoded length, so they agree only for
  // unencoded parts. Use it only when it picks exactly one, then fall back to
  // position, which is how the rows were created.
  const exact = sameName.filter((p) => (p.size ?? 0) === size)
  if (exact.length === 1) return exact[0].part ?? null
  return (sameName[occurrence] ?? sameName[0]).part ?? null
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
  att: { filename: string; size: number; messageId: string },
  occurrence: number
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
            att.size,
            occurrence
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
      const match = findParsedAttachment(parsed.attachments, att.filename, att.size, occurrence)
      if (!match?.content) throw new Error('Attachment not found on server')

      return writeAttachmentFile(
        attachmentId,
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
  att: { filename: string; size: number; messageId: string },
  occurrence: number
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
    const match = findParsedAttachment(parsed.attachments, att.filename, att.size, occurrence)
    if (!match?.content) throw new Error('Attachment not found on server')

    return writeAttachmentFile(
      attachmentId,
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

  const occurrence = attachmentOccurrence(att.messageId, attachmentId, att.filename)

  if (context.provider === 'pop3') {
    return downloadAttachmentFromPop3(attachmentId, att, occurrence)
  }

  return downloadAttachmentFromImap(attachmentId, att, occurrence)
}
