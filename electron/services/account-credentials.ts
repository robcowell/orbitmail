import { safeStorage } from 'electron'
import type { ConnectionSecurity, Provider } from '../../shared/types'

export interface TokenData {
  authType: 'oauth'
  accessToken: string
  refreshToken?: string
  expiryDate?: number
  email: string
  displayName: string
}

export interface ServerConfig {
  host: string
  port: number
  security: ConnectionSecurity
}

export interface ManualAccountCredentials {
  authType: 'password'
  email: string
  displayName: string
  username: string
  password: string
  incoming: ServerConfig
  outgoing: ServerConfig
}

export type AccountCredentials = TokenData | ManualAccountCredentials

export function encryptCredentials(data: AccountCredentials): string {
  const json = JSON.stringify(data)
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(json).toString('base64')
  }
  return Buffer.from(json).toString('base64')
}

export function decryptCredentials(blob: string): AccountCredentials {
  const raw = Buffer.from(blob, 'base64')
  const json = safeStorage.isEncryptionAvailable()
    ? safeStorage.decryptString(raw)
    : raw.toString('utf8')
  const parsed = JSON.parse(json) as AccountCredentials & { authType?: string }

  if (parsed.authType === 'password') {
    return parsed as ManualAccountCredentials
  }

  return {
    authType: 'oauth',
    accessToken: (parsed as TokenData).accessToken,
    refreshToken: (parsed as TokenData).refreshToken,
    expiryDate: (parsed as TokenData).expiryDate,
    email: parsed.email,
    displayName: parsed.displayName
  }
}

export function isOAuthProvider(provider: Provider): boolean {
  return provider === 'gmail' || provider === 'o365'
}

export function isPasswordProvider(provider: Provider): boolean {
  return provider === 'imap' || provider === 'pop3'
}

/**
 * Map our connection-security setting onto ImapFlow's TLS options.
 *
 * `doSTARTTLS` must be set explicitly for the STARTTLS case: left undefined,
 * ImapFlow treats the upgrade as opportunistic and continues in the clear when
 * the server does not advertise the capability, which is a downgrade path for
 * the credentials in the following LOGIN. `true` makes the upgrade mandatory —
 * the connection fails instead. Setting it alongside `secure: true` is a
 * misconfiguration ImapFlow rejects, so the SSL case leaves it unset.
 *
 * `'none'` also leaves it unset: the user asked for no requirement, but an
 * opportunistic upgrade is still better than guaranteed cleartext.
 */
export function imapConnectionSecurity(security: ConnectionSecurity): {
  secure: boolean
  doSTARTTLS?: boolean
} {
  if (security === 'ssl') return { secure: true }
  if (security === 'starttls') return { secure: false, doSTARTTLS: true }
  return { secure: false }
}

export function smtpTransportOptions(config: ServerConfig, username: string, password: string) {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'ssl',
    requireTLS: config.security === 'starttls',
    auth: {
      user: username,
      pass: password
    }
  }
}

export function pop3ClientOptions(
  config: ServerConfig,
  username: string,
  password: string
): {
  host: string
  port: number
  user: string
  password: string
  tls: boolean
} {
  return {
    host: config.host,
    port: config.port,
    user: username,
    password,
    tls: config.security === 'ssl' || config.security === 'starttls'
  }
}
