import Pop3Command from 'node-pop3'
import { simpleParser } from 'mailparser'
import {
  getManualCredentials,
  upsertFolder,
  upsertMessage,
  recalculateFolderUnread,
  getFolderUidSet,
  hasMessageUid,
  getFolderMaxUid,
  updateFolderSyncState,
  getAccountSyncDays,
  pruneMessagesOutsideSyncWindow
} from './db-service'
import { pop3ClientOptions } from './account-credentials'
import { recordAttachmentsMetadata, toAttachmentMeta } from './attachment-fetch'
import { isWithinSyncWindow } from './sync-policy'
import { computeThreadId, normalizeReferences } from './thread-util'
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

/**
 * A numeric stand-in for POP3's UIDL, because the `uid` column is an integer
 * (IMAP's model). It is *not* an identity: 32 bits of hash collide at around 1%
 * for 10k messages. Identity is `server_uid`, the UIDL itself — this only has to
 * fill the column and keep the (folder_id, uid) index happy.
 */
function hashUid(serverUid: string, msgNum: number): number {
  let hash = 0
  const input = `${serverUid}:${msgNum}`
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0
  }
  return hash || msgNum
}

function createPop3Client(accountId: string): Pop3Command {
  const creds = getManualCredentials(accountId)
  if (!creds) throw new Error('Account credentials not found')
  return new Pop3Command(pop3ClientOptions(creds.incoming, creds.username, creds.password))
}

export async function estimatePop3NewMessageCount(accountId: string): Promise<number> {
  const folder = upsertFolder(accountId, 'INBOX', 'INBOX', 'inbox')
  const knownServerUids = getFolderServerUidSet(folder.id)
  const pop3 = createPop3Client(accountId)

  try {
    const uidl = await pop3.UIDL()
    const entries = uidl ?? []
    let newCount = 0

    for (const [, serverUid] of entries.slice(-SYNC_BATCH_SIZE)) {
      if (!knownServerUids.has(serverUid)) newCount++
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
  const syncDays = getAccountSyncDays(accountId)
  const knownServerUids = getFolderServerUidSet(folder.id)
  let newCount = 0

  try {
    const uidl = await pop3.UIDL()
    const entries = uidl ?? []
    const batch = entries.slice(-SYNC_BATCH_SIZE)

    for (const [msgNumStr, serverUid] of batch) {
      const msgNum = Number(msgNumStr)
      const uid = hashUid(serverUid, msgNum)
      if (knownServerUids.has(serverUid)) continue

      const raw = await pop3.RETR(msgNum)
      if (!raw) continue

      const parsed = await simpleParser(raw)
      const date = parsed.date?.getTime() ?? Date.now()
      if (!isWithinSyncWindow(date, syncDays)) continue

      const from = formatAddress(parsed.from?.value[0])
      const to = formatAddressList(parsed.to?.value)
      const cc = formatAddressList(parsed.cc?.value)
      const subject = parsed.subject ?? '(No subject)'
      const bodyText = parsed.text ?? ''
      const bodyHtml = parsed.html ? String(parsed.html) : null
      const snippet = makeSnippet(bodyText || (parsed.textAsHtml ?? subject))
      const inReplyTo = normalizeReferences(parsed.inReplyTo)
      const references = normalizeReferences(parsed.references)
      const threadId = computeThreadId({
        messageId: parsed.messageId,
        inReplyTo,
        references,
        subject
      })

      const { id, isNew } = upsertMessage({
        folderId: folder.id,
        accountId,
        uid,
        serverUid,
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
        isRead: false,
        isStarred: false,
        hasAttachments: (parsed.attachments?.length ?? 0) > 0,
        bodyHtml,
        bodyText
      })

      if (!isNew) continue

      if (parsed.attachments?.length) {
        recordAttachmentsMetadata(id, parsed.attachments.map(toAttachmentMeta))
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

  pruneMessagesOutsideSyncWindow(accountId, syncDays)
  return newCount
}

/**
 * Delete by UIDL. This used to search for the first message whose hashed UIDL
 * matched the local `uid`, so a hash collision deleted *the wrong message* from
 * the server — irreversibly, since POP3 has no trash.
 */
export async function deletePop3MessageOnServer(
  accountId: string,
  serverUid: string
): Promise<void> {
  const pop3 = createPop3Client(accountId)
  try {
    const uidl = await pop3.UIDL()
    for (const [msgNumStr, candidate] of uidl ?? []) {
      const msgNum = Number(msgNumStr)
      if (candidate === serverUid) {
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
