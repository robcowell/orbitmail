import { app } from 'electron'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'
import { readFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { Provider, ComposePayload } from '../../shared/types'
import {
  getAccountTokens,
  getManualCredentials,
  updateAccountTokens,
  getMessage,
  listAccounts,
  type TokenData
} from './db-service'
import { appendToSentFolder, getAccountSmtpConfig } from './imap-sync'
import { smtpTransportOptions } from './account-credentials'
import { resolveGoogleAccessToken } from './oauth-google'
import { refreshMicrosoftToken } from './oauth-microsoft'
import { assertAttachmentsApproved } from './attachment-allowlist'
import { harvestContacts } from './contacts'
import { describeSentCopyFailure } from './connection-failure'

async function ensureFreshToken(
  accountId: string,
  provider: Provider,
  tokens: TokenData
): Promise<TokenData> {
  if (provider === 'gmail') {
    const resolved = await resolveGoogleAccessToken(accountId, tokens)
    return resolved.tokenData
  }

  const needsRefresh =
    !tokens.expiryDate || tokens.expiryDate < Date.now() + 120000

  if (!needsRefresh) return tokens

  const refreshed = await refreshMicrosoftToken(tokens)
  updateAccountTokens(accountId, refreshed)
  return refreshed
}

function createOAuthTransport(
  accountId: string,
  provider: Provider,
  email: string,
  accessToken: string
): nodemailer.Transporter {
  const smtp = getAccountSmtpConfig(accountId, provider)
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: false,
    // Gmail/O365 submission is STARTTLS on 587. Without requireTLS nodemailer
    // treats the upgrade as optional and would send the XOAUTH2 bearer token in
    // the clear if the server did not advertise STARTTLS. The password path
    // (smtpTransportOptions) already requires it.
    requireTLS: true,
    auth: {
      type: 'OAuth2',
      user: email,
      accessToken
    }
  })
}

function createPasswordTransport(
  accountId: string,
  provider: Provider
): nodemailer.Transporter {
  const manual = getManualCredentials(accountId)
  if (!manual) throw new Error('Account credentials not found')
  return nodemailer.createTransport(
    smtpTransportOptions(manual.outgoing, manual.username, manual.password)
  )
}

// A descriptive mailer identity for the outgoing User-Agent / X-Mailer
// headers, e.g. "Orbit Mail 0.1.0 (Linux x64; Electron 39.8.10)". Reflects
// the app version and the runtime environment (OS, arch, Electron).
function mailerIdentity(): string {
  const osNames: Record<string, string> = {
    linux: 'Linux',
    darwin: 'macOS',
    win32: 'Windows'
  }
  const os = osNames[process.platform] ?? process.platform
  return `Orbit Mail ${app.getVersion()} (${os} ${process.arch}; Electron ${process.versions.electron})`
}

/**
 * What happened *after* the message went out. The send itself is reported by
 * throwing, so an empty result means everything worked.
 */
export interface SendOutcome {
  /**
   * Why the Sent copy could not be filed, if it could not — already worded for
   * the user by `describeSentCopyFailure`, as a reason fragment the caller
   * frames. Absent when the copy was filed, and when the provider files its own.
   */
  sentCopyFailure?: string
}

export async function sendMail(
  payload: ComposePayload,
  provider: Provider
): Promise<SendOutcome> {
  // Before any credential or transport work: a payload naming a file the user
  // never chose must do nothing at all, not fail halfway through a send.
  assertAttachmentsApproved(payload.attachmentPaths)

  let transport: nodemailer.Transporter
  let fromAddress: string

  if (provider === 'imap' || provider === 'pop3') {
    const manual = getManualCredentials(payload.accountId)
    if (!manual) throw new Error('Account not found')
    fromAddress = manual.email
    transport = createPasswordTransport(payload.accountId, provider)
  } else {
    let tokens = getAccountTokens(payload.accountId)
    if (!tokens) throw new Error('Account not found')

    tokens = await ensureFreshToken(payload.accountId, provider, tokens)
    fromAddress = tokens.email
    transport = createOAuthTransport(
      payload.accountId,
      provider,
      tokens.email,
      tokens.accessToken
    )
  }

  const mailer = mailerIdentity()
  // Images pasted into the body ride as their own MIME parts, not as data: URIs
  // (which most clients strip on receipt).
  const inline = extractInlineImages(payload.bodyHtml)
  // Pinned rather than left to nodemailer, which mints one per compile: when a
  // Bcc'd message is built twice (see below) the two builds must carry the *same*
  // Message-ID, or the filed copy threads separately from the delivered one and
  // the label dedupe stops recognising them as one message.
  const messageId = `<${randomUUID()}@${fromAddress.split('@')[1] ?? 'localhost'}>`
  const mailOptions: Mail.Options = {
    from: fromAddress,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    messageId,
    subject: payload.subject,
    text: payload.bodyText,
    html: inline.html,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    headers: {
      'User-Agent': mailer,
      'X-Mailer': mailer
    }
  }

  const attachments: NonNullable<Mail.Options['attachments']> = payload.attachmentPaths?.length
    ? payload.attachmentPaths.map((path) => ({
        filename: path.split('/').pop() ?? 'attachment',
        content: readFileSync(path)
      }))
    : []
  // `cid` is what makes nodemailer build multipart/related and mark the part
  // inline, so it renders in the body rather than listing as a download.
  for (const image of inline.images) {
    attachments.push({
      filename: image.filename,
      content: image.content,
      contentType: image.contentType,
      cid: image.cid
    })
  }
  if (attachments.length > 0) mailOptions.attachments = attachments

  // Build the MIME message up front rather than letting sendMail do it, so the
  // copy filed in Sent is the same message that went out, with the same
  // Message-ID. `info.message` used to be read for this, but the SMTP transport
  // never sets it (only the stream/JSON transports do), so the append below was
  // unreachable and manual IMAP accounts kept no record of sent mail.
  const buildMime = (node: ReturnType<MailComposer['compile']>): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      node.build((err, message) => (err ? reject(err) : resolve(message)))
    })

  const composed = new MailComposer(mailOptions).compile()
  const envelope = composed.getEnvelope()
  const raw = await buildMime(composed)

  /**
   * The message as it should be *filed*, which is not the message that goes out.
   *
   * Bcc must not appear in the transmitted headers — the envelope is what routes
   * a message, and a Bcc header would disclose those recipients to everyone else
   * on it. The copy in Sent is the opposite case: it is the user's own record of
   * what they sent, and every mainstream client keeps Bcc there, so without it
   * you cannot tell afterwards who was blind-copied.
   *
   * nodemailer strips Bcc while building, and `keepBcc` on the compiled node is
   * how its own stream/JSON transports keep it — so the filed copy is a second
   * build with that set. Only when there is actually a Bcc: otherwise the two
   * builds would differ in nothing but their MIME boundaries, at the cost of
   * composing every attachment twice.
   */
  const sentCopyOf = async (transmitted: Buffer): Promise<Buffer> => {
    if (!payload.bcc?.trim()) return transmitted
    const node = new MailComposer(mailOptions).compile()
    node.keepBcc = true
    return buildMime(node)
  }

  try {
    await transport.sendMail({ raw, envelope })
  } finally {
    transport.close()
  }

  // Collect the recipients now rather than waiting for this message to come back
  // round through a Sent sync — the address you just used should autocomplete on
  // the very next compose. Bcc is deliberately included: it is a recipient the
  // user chose, and contacts are local. Harvest must never fail a completed
  // send, so it is advisory.
  try {
    harvestContacts({
      accountId: payload.accountId,
      accountEmail: fromAddress,
      from: fromAddress,
      to: [payload.to, payload.bcc].filter(Boolean).join(', '),
      cc: payload.cc,
      date: Date.now()
    })
  } catch (err) {
    console.warn('[orbit-mail] contact harvest after send failed:', err)
  }

  // Only manual IMAP accounts need this. Gmail files SMTP-submitted mail into
  // Sent Mail itself, so appending would leave the user with two copies.
  // (O365 is not as consistent here — tracked in TODO.md rather than guessed at.)
  if (provider === 'imap') {
    try {
      await appendToSentFolder(payload.accountId, provider, await sentCopyOf(raw))
    } catch (err) {
      // The message is already delivered; failing the send now would be a lie,
      // and would tempt the user into sending it a second time. So it is
      // *reported*, not thrown — this used to stop at the console.warn below,
      // and a whole account's sent mail went unfiled and unmentioned for weeks
      // because the Sent folder's name was one the app did not recognise.
      console.warn('[orbit-mail] Sent copy could not be filed:', err)
      return { sentCopyFailure: describeSentCopyFailure(err) }
    }
  }

  return {}
}

export type ComposeMode = NonNullable<ComposePayload['mode']>

function extractEmailAddress(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return (match ? match[1] : value).trim().toLowerCase()
}

function parseAddressList(value: string | undefined): string[] {
  if (!value?.trim()) return []
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
}

function getAccountEmail(accountId: string): string {
  const account = listAccounts().find((a) => a.id === accountId)
  if (!account) return ''
  if (account.provider === 'imap' || account.provider === 'pop3') {
    return getManualCredentials(accountId)?.email ?? account.email
  }
  return getAccountTokens(accountId)?.email ?? account.email
}

function buildReplyAllCc(from: string, to: string, cc: string, accountId: string): string {
  const self = extractEmailAddress(getAccountEmail(accountId))
  const fromAddr = extractEmailAddress(from)
  const recipients = [...parseAddressList(to), ...parseAddressList(cc)]
  const ccList = recipients.filter((recipient) => {
    const addr = extractEmailAddress(recipient)
    return addr !== self && addr !== fromAddr
  })
  return [...new Set(ccList)].join(', ')
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function originalAsHtml(msg: NonNullable<ReturnType<typeof getMessage>>): string {
  if (msg.bodyHtml) return msg.bodyHtml
  if (msg.bodyText) return `<p>${htmlEscape(msg.bodyText).replace(/\n/g, '<br>')}</p>`
  return ''
}

// A reply quote: an attribution line above the sender's original message,
// returned as separate quoted content so the composer can collapse it.
function replyQuote(msg: NonNullable<ReturnType<typeof getMessage>>) {
  const when = new Date(msg.date).toLocaleString()
  const attribution = `On ${when}, ${msg.from} wrote:`
  const quotedText = (msg.bodyText ?? '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return {
    quotedHtml: `<div class="gmail_attr">${htmlEscape(attribution)}</div><blockquote class="gmail_quote" style="margin:0 0 0 0.8ex;border-left:1px solid #ccc;padding-left:1ex;color:#555;">${originalAsHtml(msg)}</blockquote>`,
    quotedText: `${attribution}\n${quotedText}`
  }
}

// A forwarded message: a header block followed by the original content.
function forwardQuote(msg: NonNullable<ReturnType<typeof getMessage>>) {
  const header = [
    '---------- Forwarded message ----------',
    `From: ${msg.from}`,
    `Date: ${new Date(msg.date).toLocaleString()}`,
    `Subject: ${msg.subject}`,
    `To: ${msg.to}`
  ]
  return {
    quotedHtml: `<div class="gmail_attr">${header.map(htmlEscape).join('<br>')}</div><br>${originalAsHtml(msg)}`,
    quotedText: `${header.join('\n')}\n\n${msg.bodyText ?? ''}`
  }
}

export function buildReplyPayload(
  originalMessageId: string,
  accountId: string,
  mode: ComposeMode
): Partial<ComposePayload> {
  const msg = getMessage(originalMessageId)
  if (!msg) return { accountId }

  const reSubject = msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`
  const fwdSubject = msg.subject.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject}`
  const emptyBody = { bodyHtml: '', bodyText: '' }
  // References = the original's own References chain + its Message-ID, so the
  // reply groups under the true thread root (not just the immediate parent).
  const parentId = msg.messageId ?? msg.id
  const priorRefs = (msg.references ?? '').trim()
  const threading = {
    inReplyTo: parentId,
    references: priorRefs ? `${priorRefs} ${parentId}` : parentId,
    originalMessageId
  }

  switch (mode) {
    case 'reply':
      return {
        accountId,
        to: msg.from,
        subject: reSubject,
        ...emptyBody,
        ...replyQuote(msg),
        ...threading,
        mode: 'reply'
      }

    case 'reply-all':
      return {
        accountId,
        to: msg.from,
        cc: buildReplyAllCc(msg.from, msg.to, msg.cc, accountId) || undefined,
        subject: reSubject,
        ...emptyBody,
        ...replyQuote(msg),
        ...threading,
        mode: 'reply-all'
      }

    case 'send-again':
      return {
        accountId,
        to: msg.to,
        cc: msg.cc || undefined,
        subject: msg.subject,
        bodyHtml: msg.bodyHtml ?? (msg.bodyText ? `<p>${msg.bodyText}</p>` : ''),
        bodyText: msg.bodyText ?? '',
        mode: 'send-again',
        originalMessageId
      }

    case 'forward':
      return {
        accountId,
        subject: fwdSubject,
        ...emptyBody,
        ...forwardQuote(msg),
        mode: 'forward',
        originalMessageId
      }

    case 'forward-attachment':
      return {
        accountId,
        to: '',
        subject: fwdSubject,
        bodyText: '',
        bodyHtml: '',
        mode: 'forward-attachment',
        originalMessageId
      }

    case 'redirect':
      return {
        accountId,
        to: '',
        cc: '',
        subject: msg.subject,
        bodyText: '',
        bodyHtml: '',
        mode: 'redirect',
        originalMessageId
      }

    default:
      return { accountId }
  }
}

// ---------------------------------------------------------------------------
// Inline images.
//
// The composer holds a pasted image as a data: URI, which is what lets a draft
// persist one without any file on disk. Sending it that way would be simpler and
// wrong: Gmail and Outlook strip data: images out of received HTML, so the
// recipient sees a blank space. Instead each one becomes its own MIME part with
// a Content-ID, and the `src` is rewritten to reference it — the arrangement
// every mail client renders.
// ---------------------------------------------------------------------------

const DATA_URI_IMAGE = /src\s*=\s*(["'])(data:(image\/[a-z0-9.+-]+);base64,([^"']+))\1/gi

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg'
}

export interface InlineImage {
  cid: string
  filename: string
  contentType: string
  content: Buffer
}

/**
 * Replace every `src="data:image/...;base64,..."` with a `cid:` reference,
 * returning the parts to attach alongside.
 *
 * Content-IDs are derived from the image's own index and a random token rather
 * than its content: two identical images pasted twice are still two parts, which
 * costs a few bytes and avoids a whole class of "why did that image change"
 * bugs from over-clever deduplication.
 */
export function extractInlineImages(html: string): { html: string; images: InlineImage[] } {
  const images: InlineImage[] = []
  const rewritten = html.replace(
    DATA_URI_IMAGE,
    (_match, quote: string, _uri: string, mime: string, base64: string) => {
      const index = images.length
      const cid = `inline-${index}-${randomUUID()}@orbit-mail`
      const extension = IMAGE_EXTENSIONS[mime.toLowerCase()] ?? 'bin'
      images.push({
        cid,
        filename: `image-${index + 1}.${extension}`,
        contentType: mime,
        content: Buffer.from(base64, 'base64')
      })
      return `src=${quote}cid:${cid}${quote}`
    }
  )
  return { html: rewritten, images }
}
