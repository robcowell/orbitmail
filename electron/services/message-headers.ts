import { getFolderById, getMessageServerUid, getMessageSyncContext } from './db-service'
import { withImapClient } from './imap-pool'
import { fetchPop3Headers } from './pop3-sync'

/**
 * A message's complete header block, exactly as the server holds it — every
 * Received hop, Authentication-Results, spam-filter verdicts, the lot.
 *
 * Fetched on demand rather than stored: sync parses out only the handful of
 * headers the app uses, and keeping the full block for every message would
 * store kilobytes per row that are looked at almost never. The cost is that
 * this needs the server — offline, or for a message the server no longer has,
 * it throws and the dialog says so.
 *
 * IMAP uses BODY.PEEK[HEADER] (imapflow's `headers: true`), so looking at the
 * headers does not mark the message read. POP3 uses `TOP n 0`.
 */
export async function fetchRawHeaders(messageId: string): Promise<string> {
  const context = getMessageSyncContext(messageId)
  if (!context) throw new Error('Message not found')

  if (context.provider === 'pop3') {
    const serverUid = getMessageServerUid(messageId)
    if (!serverUid) {
      throw new Error('Cannot fetch headers for this POP3 message: its server id was never recorded')
    }
    return headerBlock(await fetchPop3Headers(context.accountId, serverUid))
  }

  const folder = getFolderById(context.folderId)
  if (!folder) throw new Error('Folder not found')

  return withImapClient(context.accountId, context.provider, async (client) => {
    const lock = await client.getMailboxLock(folder.imapPath)
    try {
      const msg = await client.fetchOne(context.uid.toString(), { headers: true }, { uid: true })
      if (!msg || !msg.headers) throw new Error('Message not found on server')
      return headerBlock(msg.headers.toString('utf8'))
    } finally {
      lock.release()
    }
  })
}

/**
 * Everything before the first blank line, with CRLF normalised. IMAP's HEADER
 * section ends with the blank separator; POP3's TOP may also carry it. Neither
 * is a header.
 */
export function headerBlock(raw: string): string {
  const text = raw.replace(/\r\n/g, '\n')
  const end = text.indexOf('\n\n')
  return (end < 0 ? text : text.slice(0, end)).replace(/\n+$/, '')
}
