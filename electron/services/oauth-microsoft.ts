import {
  PublicClientApplication,
  type AuthenticationResult
} from '@azure/msal-node'
import { startLoopbackServer, openExternalAuthUrl } from './oauth-loopback'
import type { TokenData } from './db-service'

const MS_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'https://outlook.office.com/SMTP.Send'
]

function getMsalApp(redirectUri: string): PublicClientApplication {
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

export async function authenticateMicrosoft(): Promise<TokenData> {
  const loopback = await startLoopbackServer()
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
  const msal = getMsalApp(redirectUri)

  const authUrl = await msal.getAuthCodeUrl({
    scopes: MS_SCOPES,
    redirectUri,
    prompt: 'select_account'
  })

  await openExternalAuthUrl(authUrl)
  const { code } = await loopback.waitForCode()
  loopback.close()

  const result: AuthenticationResult | null = await msal.acquireTokenByCode({
    code,
    scopes: MS_SCOPES,
    redirectUri
  })

  if (!result?.accessToken) {
    throw new Error('Microsoft authentication failed')
  }

  const email = result.account?.username ?? 'unknown@outlook.com'
  const displayName = result.account?.name ?? email

  return {
    accessToken: result.accessToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : undefined,
    email,
    displayName
  }
}

export async function refreshMicrosoftToken(
  tokenData: TokenData,
  accountUsername: string
): Promise<TokenData> {
  const loopback = await startLoopbackServer()
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`
  const msal = getMsalApp(redirectUri)

  const accounts = await msal.getTokenCache().getAllAccounts()
  const account = accounts.find((a) => a.username === accountUsername)

  if (!account) {
    throw new Error('Microsoft account not in cache — re-authenticate')
  }

  const result = await msal.acquireTokenSilent({
    scopes: MS_SCOPES,
    account,
    redirectUri
  })

  if (!result?.accessToken) {
    throw new Error('Failed to refresh Microsoft token')
  }

  return {
    ...tokenData,
    accessToken: result.accessToken,
    expiryDate: result.expiresOn ? result.expiresOn.getTime() : undefined
  }
}
