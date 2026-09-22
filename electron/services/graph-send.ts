// Sending Microsoft 365 mail through Microsoft Graph instead of SMTP.
//
// Many organisations switch SMTP AUTH off, and then an OAuth account cannot send
// over SMTP however valid its token is. Graph's `sendMail` does not use SMTP
// AUTH at all. It also files the message in Sent Items itself, which SMTP
// submission to Exchange does not reliably do.
//
// The message goes as MIME — the same bytes `smtp-send.ts` already builds — so
// threading headers, the pinned Message-ID, inline images and attachments all
// travel exactly as they do over SMTP. Graph reads the recipients from the
// headers rather than from an envelope, which is why the MIME handed here must
// carry its Bcc header: without it the Bcc recipients are simply never sent to.
//
// This module imports nothing (fetch is a global) so `test:pure` can drive it
// against a fake Graph server.

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'

/**
 * Graph caps a request at 4 MB, and `sendMail` takes the MIME base64-encoded,
 * which grows it by a third. Kept a little under the cap, because the limit is
 * on the whole request and Microsoft does not publish exactly what else counts.
 */
export const SIMPLE_SEND_LIMIT = 4 * 1024 * 1024 - 64 * 1024

/** Below this an attachment goes in one request; at or above it, an upload session. */
export const UPLOAD_SESSION_THRESHOLD = 3 * 1024 * 1024

/**
 * Bytes per PUT to an upload session. Graph wants each range under 4 MB; this is
 * ten 320 KiB blocks, the unit its upload endpoints align to.
 */
export const UPLOAD_CHUNK = 10 * 320 * 1024

export interface GraphAttachment {
  name: string
  contentType: string
  content: Buffer
  /** Set for an image the HTML body references as `cid:…`, without the brackets. */
  contentId?: string
}

/** Where a Graph send failed, so the wording can say whether anything was left behind. */
export type GraphSendStage = 'send' | 'draft' | 'attach' | 'dispatch'

/**
 * A refusal from Graph. `graphStatus`/`graphCode` are what `describeSendFailure`
 * reads — it matches on the shape rather than the class, because it must not
 * import this module.
 */
export class GraphSendError extends Error {
  readonly graphStatus: number
  readonly graphCode: string
  readonly stage: GraphSendStage

  constructor(stage: GraphSendStage, status: number, code: string, message: string) {
    super(message || `Microsoft Graph returned ${status}`)
    this.name = 'GraphSendError'
    this.graphStatus = status
    this.graphCode = code
    this.stage = stage
  }
}

/**
 * A cached Graph token counts as usable only with this much life left, so it
 * cannot expire between being picked and the last request of a large send.
 */
export const GRAPH_TOKEN_MARGIN_MS = 2 * 60 * 1000

/** The cached Graph token if it is still good for a whole send, else null. */
export function usableGraphToken(
  cached: { graphAccessToken?: string; graphExpiryDate?: number },
  now: number
): string | null {
  if (!cached.graphAccessToken || typeof cached.graphExpiryDate !== 'number') return null
  return cached.graphExpiryDate - GRAPH_TOKEN_MARGIN_MS > now ? cached.graphAccessToken : null
}

/** Whether a MIME message this size can go in a single `sendMail` request. */
export function fitsSimpleSend(mimeBytes: number): boolean {
  return Math.ceil(mimeBytes / 3) * 4 <= SIMPLE_SEND_LIMIT
}

async function fail(stage: GraphSendStage, res: Response): Promise<never> {
  let code = ''
  let message = ''
  try {
    const body = (await res.json()) as { error?: { code?: unknown; message?: unknown } }
    if (typeof body?.error?.code === 'string') code = body.error.code
    if (typeof body?.error?.message === 'string') message = body.error.message
  } catch {
    // Not JSON — a proxy's error page, or nothing at all. The status still says enough.
  }
  throw new GraphSendError(stage, res.status, code, message)
}

/** Send a message that fits in one request. Graph files it in Sent Items. */
export async function sendMimeViaGraph(
  accessToken: string,
  mime: Buffer,
  baseUrl: string = GRAPH_BASE
): Promise<void> {
  const res = await fetch(`${baseUrl}/me/sendMail`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'text/plain' },
    body: mime.toString('base64')
  })
  if (res.status !== 202) await fail('send', res)
}

/**
 * Send a message too big for one request: create it as a draft from MIME that
 * carries no attachments, add each attachment separately, then send the draft.
 *
 * If anything fails after the draft exists, the draft is deleted, so a failed
 * send does not leave a half-built copy in the user's Outlook Drafts. The
 * message the user wrote is still in Orbit Mail's own Drafts either way.
 */
export async function sendLargeViaGraph(
  accessToken: string,
  draftMime: Buffer,
  attachments: GraphAttachment[],
  baseUrl: string = GRAPH_BASE
): Promise<void> {
  const auth = { Authorization: `Bearer ${accessToken}` }

  const created = await fetch(`${baseUrl}/me/messages`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'text/plain' },
    body: draftMime.toString('base64')
  })
  if (created.status !== 201) await fail('draft', created)
  const { id } = (await created.json()) as { id?: unknown }
  if (typeof id !== 'string' || !id) {
    throw new GraphSendError('draft', created.status, '', 'Microsoft Graph created no draft id')
  }
  const message = `${baseUrl}/me/messages/${encodeURIComponent(id)}`

  try {
    for (const attachment of attachments) {
      await addAttachment(message, auth, attachment)
    }
    const sent = await fetch(`${message}/send`, { method: 'POST', headers: auth })
    if (sent.status !== 202) await fail('dispatch', sent)
  } catch (err) {
    // A dispatch that failed may or may not have gone out, and deleting the
    // draft does not change that. Everything before dispatch definitely did not.
    await fetch(message, { method: 'DELETE', headers: auth }).catch(() => undefined)
    throw err
  }
}

async function addAttachment(
  message: string,
  auth: Record<string, string>,
  attachment: GraphAttachment
): Promise<void> {
  const inline = attachment.contentId !== undefined

  if (attachment.content.length < UPLOAD_SESSION_THRESHOLD) {
    const res = await fetch(`${message}/attachments`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: attachment.name,
        contentType: attachment.contentType,
        contentBytes: attachment.content.toString('base64'),
        isInline: inline,
        ...(inline ? { contentId: attachment.contentId } : {})
      })
    })
    if (res.status !== 201) await fail('attach', res)
    return
  }

  const session = await fetch(`${message}/attachments/createUploadSession`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      AttachmentItem: {
        attachmentType: 'file',
        name: attachment.name,
        size: attachment.content.length,
        contentType: attachment.contentType,
        isInline: inline,
        ...(inline ? { contentId: attachment.contentId } : {})
      }
    })
  })
  if (session.status !== 201) await fail('attach', session)
  const { uploadUrl } = (await session.json()) as { uploadUrl?: unknown }
  if (typeof uploadUrl !== 'string' || !uploadUrl) {
    throw new GraphSendError('attach', session.status, '', 'Microsoft Graph returned no upload URL')
  }

  const total = attachment.content.length
  for (let start = 0; start < total; start += UPLOAD_CHUNK) {
    const end = Math.min(start + UPLOAD_CHUNK, total)
    // No Authorization header: the upload URL carries its own token, and Graph
    // rejects a request to it that also sends one.
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes ${start}-${end - 1}/${total}`
      },
      body: attachment.content.subarray(start, end)
    })
    // 200 while more is expected, 201 once the attachment exists.
    if (res.status !== (end === total ? 201 : 200)) await fail('attach', res)
  }
}
