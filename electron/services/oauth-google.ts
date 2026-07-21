import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library'
import { startLoopbackServer, openExternalAuthUrl, generateState } from './oauth-loopback'
import { updateAccountTokens, type TokenData } from './db-service'
import { getGoogleOAuthConfig } from './oauth-config'

const GMAIL_SCOPE = 'https://mail.google.com/'

function getGoogleClient(): OAuth2Client {
  // Throws with the configured sources listed if absent — see oauth-config.ts.
  const { clientId, clientSecret } = getGoogleOAuthConfig()
  return new OAuth2Client(clientId, clientSecret)
}

async function validateGoogleMailScope(accessToken: string): Promise<void> {
  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  )
  const info = (await res.json()) as { scope?: string; error_description?: string; error?: string }

  if (!res.ok || info.error) {
    throw new Error(
      info.error_description ??
        info.error ??
        'Google token validation failed. Try adding the account again.'
    )
  }

  if (!info.scope?.includes('mail.google.com')) {
    throw new Error(
      'Gmail access was not granted. Add the account again and approve all requested permissions.'
    )
  }
}

export async function authenticateGoogle(): Promise<TokenData> {
  const client = getGoogleClient()
  const state = generateState()
  const loopback = await startLoopbackServer({ expectedState: state })
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`

  let code: string
  // PKCE binds the authorization code to this attempt: the code is worthless
  // without the verifier, which never leaves the process. `state` is checked by
  // the loopback listener before the code is accepted at all.
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()

  try {
    const authUrl = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'select_account consent',
      include_granted_scopes: true,
      scope: [GMAIL_SCOPE, 'openid', 'email', 'profile'],
      redirect_uri: redirectUri,
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      code_challenge: codeChallenge
    })

    await openExternalAuthUrl(authUrl)
    code = await loopback.waitForCode()
  } finally {
    // Covers the abandoned/failed sign-in too, which previously left the
    // listener bound for the life of the app.
    loopback.close()
  }

  const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri })
  client.setCredentials(tokens)

  const accessToken = tokens.access_token
  const refreshToken = tokens.refresh_token
  const expiryDate = tokens.expiry_date

  if (!accessToken) {
    throw new Error('Google did not return an access token.')
  }

  if (!refreshToken) {
    throw new Error(
      'Google did not provide a refresh token for this account. ' +
        'Remove Orbit Mail at https://myaccount.google.com/permissions, then add the account again.'
    )
  }

  await validateGoogleMailScope(accessToken)

  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  if (!res.ok) {
    throw new Error('Failed to fetch Google profile after sign-in.')
  }
  const profile = (await res.json()) as { email: string; name?: string }

  return {
    accessToken,
    refreshToken,
    expiryDate,
    email: profile.email,
    displayName: profile.name ?? profile.email
  }
}

export async function resolveGoogleAccessToken(
  accountId: string,
  tokenData: TokenData
): Promise<{ accessToken: string; tokenData: TokenData }> {
  if (!tokenData.refreshToken) {
    if (tokenData.expiryDate && tokenData.expiryDate > Date.now() + 60000) {
      return { accessToken: tokenData.accessToken, tokenData }
    }
    throw new Error(
      `No refresh token stored for ${tokenData.email}. Remove the account and sign in again.`
    )
  }

  const client = getGoogleClient()
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
    expiry_date: tokenData.expiryDate
  })

  const response = await client.getAccessToken()
  const accessToken = response?.token
  if (!accessToken) {
    throw new Error(
      `Unable to refresh Google access for ${tokenData.email}. Remove the account and sign in again.`
    )
  }

  const credentials = client.credentials
  const updated: TokenData = {
    ...tokenData,
    accessToken: credentials.access_token ?? accessToken,
    expiryDate: credentials.expiry_date ?? tokenData.expiryDate,
    refreshToken: credentials.refresh_token ?? tokenData.refreshToken
  }

  if (
    updated.accessToken !== tokenData.accessToken ||
    updated.expiryDate !== tokenData.expiryDate ||
    updated.refreshToken !== tokenData.refreshToken
  ) {
    updateAccountTokens(accountId, updated)
  }

  return { accessToken, tokenData: updated }
}

export async function refreshGoogleToken(tokenData: TokenData): Promise<TokenData> {
  const client = getGoogleClient()
  client.setCredentials({
    access_token: tokenData.accessToken,
    refresh_token: tokenData.refreshToken,
    expiry_date: tokenData.expiryDate
  })

  const { credentials } = await client.refreshAccessToken()
  return {
    ...tokenData,
    accessToken: credentials.access_token!,
    expiryDate: credentials.expiry_date,
    refreshToken: credentials.refresh_token ?? tokenData.refreshToken
  }
}

export function formatGmailAuthError(err: unknown, email: string): Error {
  const message = err instanceof Error ? err.message : String(err)
  const authFailed =
    message.includes('AUTHENTICATIONFAILED') ||
    message.includes('Invalid credentials') ||
    message.includes('invalid_request')

  if (!authFailed) {
    return err instanceof Error ? err : new Error(message)
  }

  return new Error(
    `Gmail sign-in failed for ${email}. Check that:\n` +
      `• The OAuth app is "In production" (to allow any Gmail account), or this address is on the test-user allowlist\n` +
      `• You clicked through any "Google hasn't verified this app" warning (Advanced → Go to Orbit Mail)\n` +
      `• IMAP is enabled in Gmail settings\n` +
      `• You approved all permissions including full Gmail access\n` +
      `Then remove the account in Orbit Mail and add it again.`
  )
}
