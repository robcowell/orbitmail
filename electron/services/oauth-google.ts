import { OAuth2Client } from 'google-auth-library'
import { startLoopbackServer, openExternalAuthUrl } from './oauth-loopback'
import type { TokenData } from './db-service'

const GMAIL_SCOPE = 'https://mail.google.com/'

function getGoogleClient(): OAuth2Client {
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set in .env')
  }
  return new OAuth2Client(clientId, clientSecret)
}

export async function authenticateGoogle(): Promise<TokenData> {
  const client = getGoogleClient()
  const loopback = await startLoopbackServer()
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`

  const authUrl = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GMAIL_SCOPE, 'openid', 'email', 'profile'],
    redirect_uri: redirectUri
  })

  await openExternalAuthUrl(authUrl)
  const { code } = await loopback.waitForCode()
  loopback.close()

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri })
  client.setCredentials(tokens)

  const accessToken = tokens.access_token!
  const refreshToken = tokens.refresh_token
  const expiryDate = tokens.expiry_date

  // Fetch user profile
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  })
  const profile = (await res.json()) as { email: string; name?: string }

  return {
    accessToken,
    refreshToken,
    expiryDate,
    email: profile.email,
    displayName: profile.name ?? profile.email
  }
}

export async function refreshGoogleToken(
  tokenData: TokenData
): Promise<TokenData> {
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

export function getGoogleAccessToken(tokenData: TokenData): string {
  if (tokenData.expiryDate && tokenData.expiryDate < Date.now() + 60000) {
    throw new Error('Token expired — refresh required')
  }
  return tokenData.accessToken
}
