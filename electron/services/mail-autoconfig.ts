import { request as httpsRequest } from 'https'
import type {
  AutodetectResult,
  ConnectionSecurity,
  ManualAccountInput
} from '../../shared/types'

const FETCH_TIMEOUT_MS = 8000

function domainFromEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at === -1) return ''
  return email.slice(at + 1).trim().toLowerCase()
}

function fetchText(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { method: 'GET', timeout: FETCH_TIMEOUT_MS }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        res.resume()
        resolve(null)
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.end()
  })
}

function parseSecurity(type: string, port: number): ConnectionSecurity {
  const normalized = type.toLowerCase()
  // The type string names the scheme when present, and wins over the port.
  // Check STARTTLS before SSL/TLS: 'starttls'.includes('tls') is true, so the
  // SSL branch would otherwise claim a STARTTLS socketType and store the account
  // as implicit SSL — which then hangs on a TLS handshake against the plaintext
  // upgrade port (143/587).
  if (normalized.includes('starttls')) return 'starttls'
  if (normalized.includes('ssl') || normalized.includes('tls')) return 'ssl'
  // No scheme in the type string — fall back to well-known ports.
  if (port === 465 || port === 993 || port === 995) return 'ssl'
  if (port === 587 || port === 143 || port === 110) return 'starttls'
  return port === 25 ? 'none' : 'starttls'
}

// Exported for the integration suite: this is the pure XML→settings parse, with
// no network, so the STARTTLS-vs-SSL classification can be tested directly.
export function parseAutoconfigXml(xml: string): Partial<ManualAccountInput> | null {
  const incomingMatch = xml.match(
    /<incomingServer[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/incomingServer>/i
  )
  const outgoingMatch = xml.match(
    /<outgoingServer[^>]*type="([^"]+)"[^>]*>([\s\S]*?)<\/outgoingServer>/i
  )
  if (!incomingMatch || !outgoingMatch) return null

  const readTag = (block: string, tag: string): string | null => {
    const match = block.match(new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i'))
    return match?.[1]?.trim() ?? null
  }

  const incomingType = incomingMatch[1].toLowerCase()
  const incomingBlock = incomingMatch[2]
  const outgoingBlock = outgoingMatch[2]

  const incomingHost = readTag(incomingBlock, 'hostname')
  const incomingPort = Number(readTag(incomingBlock, 'port'))
  const incomingSocket = readTag(incomingBlock, 'socketType') ?? 'SSL'

  const outgoingHost = readTag(outgoingBlock, 'hostname')
  const outgoingPort = Number(readTag(outgoingBlock, 'port'))
  const outgoingSocket = readTag(outgoingBlock, 'socketType') ?? 'STARTTLS'

  if (!incomingHost || !outgoingHost || !incomingPort || !outgoingPort) return null

  const incomingProtocol = incomingType.includes('pop') ? 'pop3' : 'imap'

  return {
    incomingProtocol,
    incoming: {
      host: incomingHost,
      port: incomingPort,
      security: parseSecurity(incomingSocket, incomingPort)
    },
    outgoing: {
      host: outgoingHost,
      port: outgoingPort,
      security: parseSecurity(outgoingSocket, outgoingPort)
    }
  }
}

function guessFromDomain(domain: string): Partial<ManualAccountInput> | null {
  const presets: Record<string, Partial<ManualAccountInput>> = {
    'gmail.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.gmail.com', port: 587, security: 'starttls' }
    },
    'googlemail.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.gmail.com', port: 587, security: 'starttls' }
    },
    'outlook.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.office365.com', port: 587, security: 'starttls' }
    },
    'hotmail.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.office365.com', port: 587, security: 'starttls' }
    },
    'live.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'outlook.office365.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.office365.com', port: 587, security: 'starttls' }
    },
    'yahoo.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.mail.yahoo.com', port: 587, security: 'starttls' }
    },
    'yahoo.co.uk': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.mail.yahoo.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.mail.yahoo.com', port: 587, security: 'starttls' }
    },
    'icloud.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }
    },
    'me.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.mail.me.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' }
    },
    'fastmail.com': {
      incomingProtocol: 'imap',
      incoming: { host: 'imap.fastmail.com', port: 993, security: 'ssl' },
      outgoing: { host: 'smtp.fastmail.com', port: 587, security: 'starttls' }
    }
  }

  if (presets[domain]) return presets[domain]

  return {
    incomingProtocol: 'imap',
    incoming: {
      host: `imap.${domain}`,
      port: 993,
      security: 'ssl'
    },
    outgoing: {
      host: `smtp.${domain}`,
      port: 587,
      security: 'starttls'
    }
  }
}

export async function autodetectMailSettings(email: string): Promise<AutodetectResult> {
  const domain = domainFromEmail(email)
  if (!domain) {
    return { settings: null, source: null, message: 'Enter a valid email address first.' }
  }

  const urls = [
    `https://autoconfig.thunderbird.net/v1.1/${domain}`,
    `https://${domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`,
    `https://autoconfig.${domain}/mail/config-v1.1.xml?emailaddress=${encodeURIComponent(email)}`
  ]

  for (const url of urls) {
    const xml = await fetchText(url)
    if (!xml) continue
    const parsed = parseAutoconfigXml(xml)
    if (parsed) {
      return {
        settings: {
          email,
          username: email,
          ...parsed
        },
        source: 'autoconfig',
        message: `Detected settings from ${new URL(url).hostname}.`
      }
    }
  }

  const guessed = guessFromDomain(domain)
  if (guessed) {
    return {
      settings: {
        email,
        username: email,
        ...guessed
      },
      source: 'guess',
      message: 'Could not fetch provider autoconfig; filled common defaults. Verify server settings.'
    }
  }

  return {
    settings: null,
    source: null,
    message: 'No autoconfig found for this domain.'
  }
}
