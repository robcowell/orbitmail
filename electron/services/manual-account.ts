import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import Pop3Command from 'node-pop3'
import type { ManualAccountInput, Provider } from '../../shared/types'
import {
  saveManualAccount,
  type ManualAccountCredentials
} from './db-service'
import {
  imapFlowSecure,
  pop3ClientOptions,
  smtpTransportOptions
} from './account-credentials'

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
      secure: imapFlowSecure(creds.incoming.security),
      auth: {
        user: creds.username,
        pass: creds.password
      },
      logger: false
    })
    try {
      await client.connect()
      await client.logout()
    } finally {
      await client.close()
    }
  } else {
    const pop3 = new Pop3Command(
      pop3ClientOptions(creds.incoming, creds.username, creds.password)
    )
    try {
      await pop3.STAT()
    } finally {
      await pop3.QUIT().catch(() => {})
    }
  }

  const transport = nodemailer.createTransport(
    smtpTransportOptions(creds.outgoing, creds.username, creds.password)
  )
  try {
    await transport.verify()
  } finally {
    transport.close()
  }
}

export async function addManualAccount(input: ManualAccountInput) {
  await testManualAccountInput(input)
  const provider: Provider = input.incomingProtocol === 'pop3' ? 'pop3' : 'imap'
  return saveManualAccount(provider, toCredentials(input))
}
