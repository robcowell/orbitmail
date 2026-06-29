import nodemailer from 'nodemailer'
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

  const mailOptions: Mail.Options = {
    from: fromAddress,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    subject: payload.subject,
    text: payload.bodyText,
    html: payload.bodyHtml,
    inReplyTo: payload.inReplyTo,
    references: payload.references
  }

  if (payload.attachmentPaths?.length) {
    mailOptions.attachments = payload.attachmentPaths.map((path) => ({
      filename: path.split('/').pop() ?? 'attachment',
      content: readFileSync(path)
    }))
  }

  const info = await transport.sendMail(mailOptions)
  transport.close()

  if (info.message) {
    const raw =
      typeof info.message === 'string'
        ? Buffer.from(info.message)
        : Buffer.from(info.message.toString())
    await appendToSentFolder(payload.accountId, provider, raw)
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

function quotedBody(msg: NonNullable<ReturnType<typeof getMessage>>) {
  return {
    bodyHtml: `<br><br><blockquote>${msg.bodyHtml ?? msg.bodyText ?? ''}</blockquote>`,
    bodyText: `\n\n${msg.bodyText ?? ''}`
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
  const quote = quotedBody(msg)
  const threading = {
    inReplyTo: msg.messageId ?? msg.id,
    references: msg.messageId ?? msg.id,
    originalMessageId
  }

  switch (mode) {
    case 'reply':
      return {
        accountId,
        to: msg.from,
        subject: reSubject,
        ...quote,
        ...threading,
        mode: 'reply'
      }

    case 'reply-all':
      return {
        accountId,
        to: msg.from,
        cc: buildReplyAllCc(msg.from, msg.to, msg.cc, accountId) || undefined,
        subject: reSubject,
        ...quote,
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
        bodyHtml: `<br><br>---------- Forwarded message ----------<br>${msg.bodyHtml ?? msg.bodyText ?? ''}`,
        bodyText: `\n\n---------- Forwarded message ----------\n${msg.bodyText ?? ''}`,
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
