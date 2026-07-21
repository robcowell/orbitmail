import {
  PublicClientApplication,
  CryptoProvider,
  type AuthenticationResult,
  type JsonCache
} from '@azure/msal-node'
import { startLoopbackServer, openExternalAuthUrl, generateState } from './oauth-loopback'
import type { TokenData } from './db-service'

// Delegated scopes for IMAP/SMTP client access to Exchange Online via XOAUTH2.
// These are requested dynamically at sign-in and consented by the user, so they do
// NOT need to be pre-registered under "API permissions" in the Entra portal.
const MS_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
]

function getMsalApp(): PublicClientApplication {
  const clientId = process.env.MICROSOFT_CLIENT_ID
  const tenantId = process.env.MICROSOFT_TENANT_ID ?? 'common'
  if (!clientId) {
    throw new Error('MICROSOFT_CLIENT_ID must be set in .env')
  }

  return new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`
    }
  })
}

/**
 * MSAL keeps refresh tokens inside its in-memory cache, which is lost on restart.
 * Pull the refresh token out of the serialized cache so we can persist it in our own
 * encrypted token_blob — mirroring how Gmail refresh tokens are stored.
 */
function extractRefreshToken(msal: PublicClientApplication): string | undefined {
  try {
    const cache = JSON.parse(msal.getTokenCache().serialize()) as JsonCache
    const entries = Object.values(cache.RefreshToken ?? {})
    return entries.find((entry) => entry?.secret)?.secret
  } catch {
    return undefined
  }
}

export async function authenticateMicrosoft(): Promise<TokenData> {
  const state = generateState()
  const loopback = await startLoopbackServer({ expectedState: state })
  // RFC 8252 loopback redirect. Entra ignores the port for loopback URIs, so the
  // app registration only needs the redirect URI `http://127.0.0.1/callback` once.
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
  const msal = getMsalApp()

  let result: AuthenticationResult | null
  try {
    // PKCE binds the authorization code to this attempt; `state` is checked by
    // the loopback listener before the code is accepted at all. MSAL does not
    // add either unless asked.
    const { verifier, challenge } = await new CryptoProvider().generatePkceCodes()

    const authUrl = await msal.getAuthCodeUrl({
      scopes: MS_SCOPES,
      redirectUri,
      prompt: 'select_account',
      state,
      codeChallenge: challenge,
      codeChallengeMethod: 'S256'
    })

    await openExternalAuthUrl(authUrl)
    const code = await loopback.waitForCode()

    result = await msal.acquireTokenByCode({
      code,
      scopes: MS_SCOPES,
      redirectUri,
      codeVerifier: verifier,
      state
    })
  } finally {
    loopback.close()
  }

  if (!result?.accessToken) {
    throw new Error('Microsoft authentication failed — no access token was returned.')
  }

  const refreshToken = extractRefreshToken(msal)
  if (!refreshToken) {
    throw new Error(
      'Microsoft did not return a refresh token, so the account would stop working after ' +
        'restart. In your Entra app registration enable "Allow public client flows" and keep ' +
        'the "offline_access" scope, then add the account again.'
    )
  }

  const email = result.account?.username ?? 'unknown@outlook.com'
  const displayName = result.account?.name ?? email

  return {
    accessToken: result.accessToken,
    refreshToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : undefined,
    email,
    displayName
  }
}

export async function refreshMicrosoftToken(tokenData: TokenData): Promise<TokenData> {
  if (!tokenData.refreshToken) {
    throw new Error(
      `No Microsoft refresh token stored for ${tokenData.email}. Remove the account and sign in again.`
    )
  }

  const msal = getMsalApp()
  const result = await msal.acquireTokenByRefreshToken({
    refreshToken: tokenData.refreshToken,
    scopes: MS_SCOPES
  })

  if (!result?.accessToken) {
    throw new Error(`Failed to refresh Microsoft access for ${tokenData.email}.`)
  }

  return {
    ...tokenData,
    accessToken: result.accessToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : tokenData.expiryDate,
    // Entra rotates refresh tokens; keep the newest, falling back to the existing one.
    refreshToken: extractRefreshToken(msal) ?? tokenData.refreshToken
  }
}
