// OAuth client credentials.
//
// **Credentials are never compiled into a build.** See CLAUDE.md, rule 5. A
// build must be safe to hand to another person, and anything baked into the
// bundle ships with it — the builder would be distributing their own Google
// client secret and Microsoft app identity, with abuse landing on their Cloud
// project. That cannot be recalled once a package is out.
//
// This is not hypothetical: a build-time `define` briefly inlined the project
// `.env` here, and `npm run dist:deb` produced a .deb containing a real client
// secret. It was removed. `npm run test:imap` now fails if any credential value
// reappears in the build output, or if the build config regains OAuth
// constants.
//
// So they are supplied at runtime, on the machine that runs the app. First hit
// wins:
//
//   1. the process environment — a developer's .env, loaded by dotenv in main.ts
//   2. ~/.config/orbit-mail/.env — for someone running a packaged build
//   3. entered in the app when adding an account, stored encrypted via
//      safeStorage (the same mechanism the Anthropic API key uses)
//
// Client IDs are not secrets — they appear in the browser URL during sign-in.
// The Google *secret* for an installed app is not confidential either
// (RFC 8252 §8.5), which is why the flow also uses PKCE. That is a reason not
// to panic if one leaks; it is not a reason to ship one.

import { safeStorage } from 'electron'
import { getRawSqlite } from '../db'
import type { OAuthConfigStatus } from '../../shared/types'

export type OAuthCredentialKey =
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MICROSOFT_CLIENT_ID'
  | 'MICROSOFT_TENANT_ID'

/** Environment first, then anything entered in the app. Never compiled in. */
function resolve(key: OAuthCredentialKey): string {
  return process.env[key]?.trim() || readStored(key)
}

function missing(names: string[]): Error {
  const plural = names.length > 1
  return new Error(
    `${names.join(' and ')} ${plural ? 'are' : 'is'} not configured.\n\n` +
      `Supply ${plural ? 'them' : 'it'} in one of:\n` +
      `  • this dialog — stored encrypted on this machine\n` +
      `  • ~/.config/orbit-mail/.env\n` +
      `  • the environment before launching\n\n` +
      `Registering an OAuth app takes a few minutes: see DEVELOPERS.md → OAuth setup.`
  )
}

export function getGoogleOAuthConfig(): { clientId: string; clientSecret: string } {
  const clientId = resolve('GOOGLE_CLIENT_ID')
  const clientSecret = resolve('GOOGLE_CLIENT_SECRET')

  const absent: string[] = []
  if (!clientId) absent.push('GOOGLE_CLIENT_ID')
  if (!clientSecret) absent.push('GOOGLE_CLIENT_SECRET')
  if (absent.length) throw missing(absent)

  return { clientId, clientSecret }
}

export function getMicrosoftOAuthConfig(): { clientId: string; tenantId: string } {
  const clientId = resolve('MICROSOFT_CLIENT_ID')
  if (!clientId) throw missing(['MICROSOFT_CLIENT_ID'])
  return { clientId, tenantId: resolve('MICROSOFT_TENANT_ID') || 'common' }
}

export function hasGoogleOAuthConfig(): boolean {
  return !!resolve('GOOGLE_CLIENT_ID') && !!resolve('GOOGLE_CLIENT_SECRET')
}

export function hasMicrosoftOAuthConfig(): boolean {
  return !!resolve('MICROSOFT_CLIENT_ID')
}

// ---------------------------------------------------------------------------
// Credentials entered in the app.
//
// Stored encrypted via safeStorage in app_preferences, the same mechanism the
// Anthropic API key uses. They sit *below* the environment so a developer's
// .env — or ~/.config/orbit-mail/.env — always wins and the app never silently
// disagrees with the file someone just edited.
//
// Values are never handed back to the renderer. The UI is told only whether a
// provider is configured and which keys came from the environment; it collects
// new values and writes them.
// ---------------------------------------------------------------------------

const PREF_PREFIX = 'oauth_cred_'

function encryptValue(plaintext: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(plaintext).toString('base64')
  }
  return Buffer.from(plaintext).toString('base64')
}

function decryptValue(blob: string): string {
  const raw = Buffer.from(blob, 'base64')
  return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(raw) : raw.toString('utf8')
}

function readStored(key: OAuthCredentialKey): string {
  try {
    const row = getRawSqlite()
      .prepare('SELECT value FROM app_preferences WHERE key = ?')
      .get(PREF_PREFIX + key) as { value: string } | undefined
    return row?.value ? decryptValue(row.value).trim() : ''
  } catch {
    return ''
  }
}

/** Persist credentials entered in the app. An empty value clears that key. */
export function setStoredOAuthCredentials(
  values: Partial<Record<OAuthCredentialKey, string>>
): void {
  const db = getRawSqlite()
  for (const [key, value] of Object.entries(values) as [OAuthCredentialKey, string][]) {
    const trimmed = (value ?? '').trim()
    if (!trimmed) {
      db.prepare('DELETE FROM app_preferences WHERE key = ?').run(PREF_PREFIX + key)
      continue
    }
    db.prepare(
      'INSERT INTO app_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(PREF_PREFIX + key, encryptValue(trimmed))
  }
}

/**
 * What the UI needs in order to decide whether to ask. Deliberately returns no
 * credential values — only whether each provider is usable, which keys the
 * environment already supplies (so the UI can explain why editing them here
 * would have no effect), and whether storage will actually be encrypted.
 */
export function getOAuthConfigStatus(): OAuthConfigStatus {
  const keys: OAuthCredentialKey[] = [
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_TENANT_ID'
  ]
  return {
    google: hasGoogleOAuthConfig(),
    microsoft: hasMicrosoftOAuthConfig(),
    fromEnvironment: keys.filter((key) => !!process.env[key]?.trim()),
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}
