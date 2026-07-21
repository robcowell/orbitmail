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
//
// Entering them in the app when adding an account is the next step; it will
// slot in below the environment, stored encrypted via safeStorage (the same
// mechanism the Anthropic API key already uses).
//
// Client IDs are not secrets — they appear in the browser URL during sign-in.
// The Google *secret* for an installed app is not confidential either
// (RFC 8252 §8.5), which is why the flow also uses PKCE. That is a reason not
// to panic if one leaks; it is not a reason to ship one.

export type OAuthCredentialKey =
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MICROSOFT_CLIENT_ID'
  | 'MICROSOFT_TENANT_ID'

/** Runtime environment only — never a compiled-in value. */
function resolve(key: OAuthCredentialKey): string {
  return process.env[key]?.trim() ?? ''
}

function missing(names: string[]): Error {
  const plural = names.length > 1
  return new Error(
    `${names.join(' and ')} ${plural ? 'are' : 'is'} not configured.\n\n` +
      `Supply ${plural ? 'them' : 'it'} in one of:\n` +
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
