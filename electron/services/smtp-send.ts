import nodemailer from 'nodemailer'
import type Mail from 'nodemailer/lib/mailer'
import { readFileSync } from 'fs'
import type { Provider, ComposePayload } from '../../shared/types'
import {
  getAccountTokens,
  updateAccountTokens,
  getMessage,
  type TokenData
} from './db-service'
import {
  appendToSentFolder,
  getProviderSmtpConfig
} from './imap-sync'
import { refreshGoogleToken } from './oauth-google'
import { refreshMicrosoftToken } from './oauth-microsoft'

async function ensureFreshToken(
  accountId: string,
  provider: Provider,
  tokens: TokenData
): Promise<TokenData> {
  const needsRefresh =
    !tokens.expiryDate || tokens.expiryDate < Date.now() + 120000

  if (!needsRefresh) return tokens

  let refreshed: TokenData
  if (provider === 'gmail' && tokens.refreshToken) {
    refreshed = await refreshGoogleToken(tokens)
  } else if (provider === 'o365') {
    refreshed = await refreshMicrosoftToken(tokens, tokens.email)
  } else {
    return tokens
  }

  updateAccountTokens(accountId, refreshed)
  return refreshed
}

function createTransport(
  provider: Provider,
  email: string,
  accessToken: string
): nodemailer.Transporter {
  const smtp = getProviderSmtpConfig(provider)
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

export async function sendMail(
  payload: ComposePayload,
  provider: Provider
): Promise<void> {
  let tokens = getAccountTokens(payload.accountId)
  if (!tokens) throw new Error('Account not found')

  tokens = await ensureFreshToken(payload.accountId, provider, tokens)
  const transport = createTransport(provider, tokens.email, tokens.accessToken)

  const mailOptions: Mail.Options = {
    from: tokens.email,
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

  // Append to Sent folder via IMAP
  if (info.message) {
    const raw =
      typeof info.message === 'string'
        ? Buffer.from(info.message)
        : Buffer.from(info.message.toString())
    await appendToSentFolder(payload.accountId, provider, raw)
  }
}

export function buildReplyPayload(
  originalMessageId: string,
  accountId: string,
  mode: 'reply' | 'forward'
): Partial<ComposePayload> {
  const msg = getMessage(originalMessageId)
  if (!msg) return { accountId }

  if (mode === 'reply') {
    return {
      accountId,
      to: msg.from,
      subject: msg.subject.startsWith('Re:') ? msg.subject : `Re: ${msg.subject}`,
      bodyHtml: `<br><br><blockquote>${msg.bodyHtml ?? msg.bodyText ?? ''}</blockquote>`,
      bodyText: `\n\n${msg.bodyText ?? ''}`,
      inReplyTo: msg.messageId ?? msg.id,
      references: msg.messageId ?? msg.id,
      mode: 'reply',
      originalMessageId
    }
  }

  return {
    accountId,
    subject: msg.subject.startsWith('Fwd:') ? msg.subject : `Fwd: ${msg.subject}`,
    bodyHtml: `<br><br>---------- Forwarded message ----------<br>${msg.bodyHtml ?? msg.bodyText ?? ''}`,
    bodyText: `\n\n---------- Forwarded message ----------\n${msg.bodyText ?? ''}`,
    mode: 'forward',
    originalMessageId
  }
}
