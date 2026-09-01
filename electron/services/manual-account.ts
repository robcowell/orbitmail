import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import Pop3Command from 'node-pop3'
import type {
  Account,
  ManualAccountInput,
  ManualAccountSettings,
  ManualAccountSettingsUpdate,
  Provider
} from '../../shared/types'
import {
  getAccountById,
  getManualCredentials,
  saveManualAccount,
  type ManualAccountCredentials
} from './db-service'
import {
  imapConnectionSecurity,
  pop3ClientOptions,
  smtpTransportOptions
} from './account-credentials'
import { describeConnectionFailure } from './connection-failure'

function toCredentials(input: ManualAccountInput): ManualAccountCredentials {
  return {
    authType: 'password',
    email: input.email.trim(),
    displayName: (input.displayName?.trim() || input.email.trim()),
    username: input.username.trim(),
    password: input.password,
    incoming: { ...input.incoming },
    outgoing: { ...input.outgoing }
  }
}

export async function testManualAccountInput(input: ManualAccountInput): Promise<void> {
  const creds = toCredentials(input)
  const provider: Provider = input.incomingProtocol === 'pop3' ? 'pop3' : 'imap'

  if (provider === 'imap') {
    const client = new ImapFlow({
      host: creds.incoming.host,
      port: creds.incoming.port,
      ...imapConnectionSecurity(creds.incoming.security),
      auth: {
        user: creds.username,
        pass: creds.password
      },
      logger: false
    })
    try {
      await client.connect()
      await client.logout()
    } catch (err) {
      throw describeConnectionFailure(err, 'Incoming', creds.incoming.host)
    } finally {
      await client.close()
    }
  } else {
    const pop3 = new Pop3Command(
      pop3ClientOptions(creds.incoming, creds.username, creds.password)
    )
    try {
      await pop3.STAT()
    } catch (err) {
      throw describeConnectionFailure(err, 'Incoming', creds.incoming.host)
    } finally {
      await pop3.QUIT().catch(() => {})
    }
  }

  const transport = nodemailer.createTransport(
    smtpTransportOptions(creds.outgoing, creds.username, creds.password)
  )
  try {
    await transport.verify()
  } catch (err) {
    throw describeConnectionFailure(err, 'Outgoing', creds.outgoing.host)
  } finally {
    transport.close()
  }
}

export async function addManualAccount(input: ManualAccountInput) {
  await testManualAccountInput(input)
  const provider: Provider = input.incomingProtocol === 'pop3' ? 'pop3' : 'imap'
  return saveManualAccount(provider, toCredentials(input))
}

/**
 * How long a "Test connection" may take before it is called a failure.
 *
 * `testManualAccountInput` does a live IMAP/POP3 login *and* an SMTP verify.
 * POP3 has its own socket timeout; IMAP and SMTP rely on library defaults, which
 * against a host that accepts a connection and then says nothing means the call
 * never settles — and a Test button that spins forever is worse than one that
 * says it could not connect.
 */
const TEST_CONNECTION_TIMEOUT_MS = 30_000

function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * Project stored credentials into what the renderer may see.
 *
 * **Field by field, never a spread.** `ManualAccountCredentials` carries the
 * plaintext password, so `{ ...creds }` — or any later `omit`-style helper that
 * takes a denylist — is one careless edit away from serialising it into the
 * renderer. Listing the allowed fields explicitly means a new secret added to
 * the credentials type is excluded by default rather than included by default.
 * The test asserts on the *absence of the key*, not on its value.
 */
export function toManualSettings(
  creds: ManualAccountCredentials,
  provider: 'imap' | 'pop3'
): ManualAccountSettings {
  return {
    email: creds.email,
    displayName: creds.displayName,
    username: creds.username,
    incomingProtocol: provider,
    incoming: {
      host: creds.incoming.host,
      port: creds.incoming.port,
      security: creds.incoming.security
    },
    outgoing: {
      host: creds.outgoing.host,
      port: creds.outgoing.port,
      security: creds.outgoing.security
    },
    hasPassword: creds.password.length > 0
  }
}

/**
 * Apply an edit to a manual account's server settings.
 *
 * An omitted password means "keep the stored one", and it is read here in main
 * rather than round-tripped through the renderer to preserve it. The settings
 * are proved to work *before* they are persisted — saving a broken host would
 * leave the account unable to sync with no way back except the Add Account
 * wizard.
 */
export async function updateManualAccountSettings(
  accountId: string,
  update: ManualAccountSettingsUpdate
): Promise<Account> {
  const account = getAccountById(accountId)
  if (!account) throw new Error('Account not found')
  if (account.provider !== 'imap' && account.provider !== 'pop3') {
    throw new Error('This account does not use a password')
  }
  const existing = getManualCredentials(accountId)
  if (!existing) throw new Error('This account has no stored server settings')

  const password = update.password?.trim() ? update.password : existing.password
  const next: ManualAccountCredentials = {
    authType: 'password',
    // Not editable: saveManualAccount matches on email, so a changed address
    // creates a second account row and orphans this one's mail.
    email: existing.email,
    displayName: update.displayName.trim() || existing.email,
    username: update.username.trim(),
    password,
    incoming: { ...update.incoming },
    outgoing: { ...update.outgoing }
  }

  // Same timeout as the Test button: a save that verifies first can hang in
  // exactly the same way, and the user is waiting on a dialog either way.
  await withTimeout(
    testManualAccountInput({
      email: next.email,
      displayName: next.displayName,
      username: next.username,
      password: next.password,
      incomingProtocol: account.provider,
      incoming: next.incoming,
      outgoing: next.outgoing
    }),
    TEST_CONNECTION_TIMEOUT_MS,
    'Timed out connecting — check the server and port.'
  )

  return saveManualAccount(account.provider, next)
}

/**
 * Try an edit's settings against the real servers without saving anything.
 * An omitted password means the stored one, resolved here — the renderer never
 * has it to send back.
 */
export async function testManualAccountSettings(
  accountId: string,
  update: ManualAccountSettingsUpdate
): Promise<void> {
  const account = getAccountById(accountId)
  if (!account) throw new Error('Account not found')
  if (account.provider !== 'imap' && account.provider !== 'pop3') {
    throw new Error('This account does not use a password')
  }
  const existing = getManualCredentials(accountId)
  if (!existing) throw new Error('This account has no stored server settings')

  await withTimeout(
    testManualAccountInput({
      email: existing.email,
      displayName: update.displayName,
      username: update.username.trim(),
      password: update.password?.trim() ? update.password : existing.password,
      incomingProtocol: account.provider,
      incoming: update.incoming,
      outgoing: update.outgoing
    }),
    TEST_CONNECTION_TIMEOUT_MS,
    'Timed out connecting — check the server and port.'
  )
}
