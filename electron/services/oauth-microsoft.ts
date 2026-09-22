import {
  PublicClientApplication,
  CryptoProvider,
  type AuthenticationResult,
  type JsonCache
} from '@azure/msal-node'
import { startLoopbackServer, openExternalAuthUrl, generateState } from './oauth-loopback'
import type { TokenData } from './db-service'
import { getMicrosoftOAuthConfig } from './oauth-config'
import { markReauthRequired } from './connection-failure'

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

// Sending through Microsoft Graph, for organisations that switch SMTP AUTH off.
// A token is issued for one resource at a time, and this is a different resource
// from the IMAP/SMTP scopes above, so it cannot be in the same token request. It
// is consented at sign-in (`extraScopesToConsent`) and exchanged for a separate
// token only when sending (`acquireGraphSendToken`).
export const GRAPH_SEND_SCOPE = 'https://graph.microsoft.com/Mail.Send'

function getMsalApp(): PublicClientApplication {
  const { clientId, tenantId } = getMicrosoftOAuthConfig()

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

/** `loginHint` pre-fills that address at Microsoft's sign-in, for Sign in again. */
export async function authenticateMicrosoft(loginHint?: string): Promise<TokenData> {
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
      extraScopesToConsent: [GRAPH_SEND_SCOPE],
      redirectUri,
      prompt: 'select_account',
      ...(loginHint ? { loginHint } : {}),
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
        'the "offline_access" scope, then sign in again.'
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

/**
 * A Graph access token for sending, or `null` if this account has not consented
 * to Graph sending — every account added before Graph sending existed, until it
 * signs in again. `null` means "send over SMTP as before", not a failure.
 *
 * The refresh token may rotate here as it does in `refreshMicrosoftToken`, so the
 * caller must persist the returned one, and the Graph token with its expiry —
 * see `graphAccessToken` on `TokenData`.
 */
export async function acquireGraphSendToken(
  tokenData: TokenData
): Promise<{ accessToken: string; refreshToken: string; expiryDate?: number } | null> {
  if (!tokenData.refreshToken) return null
  const msal = getMsalApp()
  let result: AuthenticationResult | null
  try {
    result = await msal.acquireTokenByRefreshToken({
      refreshToken: tokenData.refreshToken,
      scopes: [GRAPH_SEND_SCOPE]
    })
  } catch (err) {
    // Not consented (AADSTS65001), consent declined (AADSTS65004), or Microsoft
    // wanting an interactive sign-in for this scope. All mean "this account
    // cannot use Graph yet", and none stops it sending over SMTP with the token
    // it already has. Anything else — a network failure, a revoked grant — is a
    // real problem, and SMTP would meet it too.
    const text = err instanceof Error ? `${err.message} ${(err as { errorCode?: string }).errorCode ?? ''}` : String(err)
    if (/AADSTS6500[14]|consent_required|interaction_required/i.test(text)) return null
    throw err
  }
  if (!result?.accessToken) return null
  return {
    accessToken: result.accessToken,
    refreshToken: extractRefreshToken(msal) ?? tokenData.refreshToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : undefined
  }
}

export async function refreshMicrosoftToken(tokenData: TokenData): Promise<TokenData> {
  if (!tokenData.refreshToken) {
    throw markReauthRequired(
      new Error(
        `No Microsoft refresh token stored for ${tokenData.email}. Sign in to it again in Settings → Accounts.`
      )
    )
  }

  const msal = getMsalApp()
  const result = await msal.acquireTokenByRefreshToken({
    refreshToken: tokenData.refreshToken,
    scopes: MS_SCOPES
  })

  if (!result?.accessToken) {
    throw markReauthRequired(
      new Error(`Failed to refresh Microsoft access for ${tokenData.email}.`)
    )
  }

  return {
    ...tokenData,
    accessToken: result.accessToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : tokenData.expiryDate,
    // Entra rotates refresh tokens; keep the newest, falling back to the existing one.
    refreshToken: extractRefreshToken(msal) ?? tokenData.refreshToken
  }
}
