import { app } from 'electron'
import nodemailer from 'nodemailer'
import MailComposer from 'nodemailer/lib/mail-composer'
import type Mail from 'nodemailer/lib/mailer'
import { readFileSync } from 'fs'
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

export async function sendMail(
  payload: ComposePayload,
  provider: Provider
): Promise<void> {
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
  const mailOptions: Mail.Options = {
    from: fromAddress,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    text: payload.bodyText,
    html: payload.bodyHtml,
    inReplyTo: payload.inReplyTo,
    references: payload.references,
    headers: {
      'User-Agent': mailer,
      'X-Mailer': mailer
    }
  }

  if (payload.attachmentPaths?.length) {
    mailOptions.attachments = payload.attachmentPaths.map((path) => ({
      filename: path.split('/').pop() ?? 'attachment',
      content: readFileSync(path)
    }))
  }

  // Build the MIME message up front rather than letting sendMail do it, so the
  // copy filed in Sent is byte-identical to what went out — same Message-ID,
  // same boundaries. `info.message` used to be read for this, but the SMTP
  // transport never sets it (only the stream/JSON transports do), so the append
  // below was unreachable and manual IMAP accounts kept no record of sent mail.
  const composed = new MailComposer(mailOptions).compile()
  const envelope = composed.getEnvelope()
  const raw: Buffer = await new Promise((resolve, reject) => {
    composed.build((err, message) => (err ? reject(err) : resolve(message)))
  })

  try {
    await transport.sendMail({ raw, envelope })
  } finally {
    transport.close()
  }

  // Only manual IMAP accounts need this. Gmail files SMTP-submitted mail into
  // Sent Mail itself, so appending would leave the user with two copies.
  // (O365 is not as consistent here — tracked in TODO.md rather than guessed at.)
  if (provider === 'imap') {
    try {
      await appendToSentFolder(payload.accountId, provider, raw)
    } catch (err) {
      // The message is already delivered; failing the send now would be a lie,
      // and would tempt the user into sending it a second time.
      console.warn('[orbit-mail] Sent copy could not be filed:', err)
    }
  }
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
