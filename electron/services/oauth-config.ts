// OAuth client credentials.
//
// These have to survive packaging. `main.ts` loads a `.env` via dotenv, which
// works in development because the dev server runs from the repo — but a
// packaged app is launched from a desktop entry with an unrelated working
// directory, and `.env` is not in `build.files`, so nothing supplied these and
// "Add Account" failed on a `.deb`/AppImage with "must be set in .env".
//
// Resolution order, first hit wins:
//   1. the process environment — a developer's `.env`, or an operator export
//   2. `~/.config/orbit-mail/.env` — lets someone using a packaged build supply
//      their own credentials without rebuilding
//   3. values baked in at build time by the `define` block in
//      electron.vite.config.ts, from whatever `.env` the build machine had
//
// Client IDs are not secrets. The Google *secret* for an installed app is not
// treated as confidential either (RFC 8252 §8.5) — it cannot be kept private in
// a binary the user runs — which is exactly why the flow also uses PKCE.

// Injected by electron.vite.config.ts. Empty string when the build machine had
// no .env, which is a legitimate state — the runtime sources above may supply
// them instead.
declare const __OAUTH_GOOGLE_CLIENT_ID__: string
declare const __OAUTH_GOOGLE_CLIENT_SECRET__: string
declare const __OAUTH_MICROSOFT_CLIENT_ID__: string
declare const __OAUTH_MICROSOFT_TENANT_ID__: string

function baked(value: string | undefined): string {
  // `typeof` guard so this module still loads if the define block is absent
  // (e.g. bundled by something other than the app build, as the tests do).
  return typeof value === 'string' ? value : ''
}

function resolve(runtimeValue: string | undefined, buildValue: string): string {
  const fromRuntime = runtimeValue?.trim()
  if (fromRuntime) return fromRuntime
  return buildValue.trim()
}

function missing(names: string[]): Error {
  return new Error(
    `${names.join(' and ')} ${names.length > 1 ? 'are' : 'is'} not configured.\n\n` +
      `Set ${names.length > 1 ? 'them' : 'it'} in one of:\n` +
      `  • the environment before launching\n` +
      `  • ~/.config/orbit-mail/.env\n` +
      `  • a .env in the project root at build time (they are baked into the build)\n\n` +
      `See DEVELOPERS.md → OAuth setup.`
  )
}

export function getGoogleOAuthConfig(): { clientId: string; clientSecret: string } {
  const clientId = resolve(
    process.env.GOOGLE_CLIENT_ID,
    baked(typeof __OAUTH_GOOGLE_CLIENT_ID__ !== 'undefined' ? __OAUTH_GOOGLE_CLIENT_ID__ : '')
  )
  const clientSecret = resolve(
    process.env.GOOGLE_CLIENT_SECRET,
    baked(
      typeof __OAUTH_GOOGLE_CLIENT_SECRET__ !== 'undefined' ? __OAUTH_GOOGLE_CLIENT_SECRET__ : ''
    )
  )

  const absent: string[] = []
  if (!clientId) absent.push('GOOGLE_CLIENT_ID')
  if (!clientSecret) absent.push('GOOGLE_CLIENT_SECRET')
  if (absent.length) throw missing(absent)

  return { clientId, clientSecret }
}

export function getMicrosoftOAuthConfig(): { clientId: string; tenantId: string } {
  const clientId = resolve(
    process.env.MICROSOFT_CLIENT_ID,
    baked(
      typeof __OAUTH_MICROSOFT_CLIENT_ID__ !== 'undefined' ? __OAUTH_MICROSOFT_CLIENT_ID__ : ''
    )
  )
  const tenantId =
    resolve(
      process.env.MICROSOFT_TENANT_ID,
      baked(
        typeof __OAUTH_MICROSOFT_TENANT_ID__ !== 'undefined' ? __OAUTH_MICROSOFT_TENANT_ID__ : ''
      )
    ) || 'common'

  if (!clientId) throw missing(['MICROSOFT_CLIENT_ID'])

  return { clientId, tenantId }
}

/** True when a provider can be offered at all — used to fail early and clearly. */
export function hasGoogleOAuthConfig(): boolean {
  try {
    getGoogleOAuthConfig()
    return true
  } catch {
    return false
  }
}

export function hasMicrosoftOAuthConfig(): boolean {
  try {
    getMicrosoftOAuthConfig()
    return true
  } catch {
    return false
  }
}
