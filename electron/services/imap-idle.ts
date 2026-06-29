import type { ImapFlow } from 'imapflow'
import type { Provider } from '../../shared/types'
import { listAccounts, upsertFolder } from './db-service'
import {
  createImapClient,
  detectFolderType,
  findInboxMailbox,
  syncFolder
} from './imap-sync'

const IDLE_RECONNECT_MS = 5000

interface IdleRuntime {
  client: ImapFlow | null
  stopping: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
}

const idleRuntimes = new Map<string, IdleRuntime>()

let onNewMail: (() => void) | null = null

export function setIdleNewMailHandler(handler: (() => void) | null): void {
  onNewMail = handler
}

export function startIdleMonitoring(): void {
  for (const account of listAccounts()) {
    if (account.provider === 'pop3') continue
    void ensureAccountIdle(account.id, account.provider)
  }
}

export function stopIdleMonitoring(): void {
  for (const [accountId, runtime] of idleRuntimes) {
    runtime.stopping = true
    if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer)
    runtime.client?.logout().catch(() => {})
    idleRuntimes.delete(accountId)
  }
}

export function restartIdleMonitoring(): void {
  stopIdleMonitoring()
  startIdleMonitoring()
}

function scheduleIdleReconnect(accountId: string, provider: Provider): void {
  const runtime = idleRuntimes.get(accountId)
  if (!runtime || runtime.stopping) return

  if (runtime.reconnectTimer) clearTimeout(runtime.reconnectTimer)
  runtime.reconnectTimer = setTimeout(() => {
    idleRuntimes.delete(accountId)
    void ensureAccountIdle(accountId, provider)
  }, IDLE_RECONNECT_MS)
}

function teardownIdleConnection(
  accountId: string,
  provider: Provider,
  runtime: IdleRuntime
): void {
  if (runtime.stopping) return
  runtime.client = null
  idleRuntimes.delete(accountId)
  scheduleIdleReconnect(accountId, provider)
}

function attachIdleClientHandlers(
  accountId: string,
  provider: Provider,
  client: ImapFlow,
  runtime: IdleRuntime
): void {
  client.on('error', (err: Error) => {
    // Idle connections drop often (sleep, network, server limits). Reconnect quietly.
    if (runtime.stopping || !idleRuntimes.has(accountId)) return
    console.warn(`[orbit-mail] IMAP IDLE error for ${accountId}:`, err.message)
    teardownIdleConnection(accountId, provider, runtime)
  })

  client.on('exists', () => {
    void handleMailboxActivity(accountId, provider, client).catch((err) => {
      console.warn(`[orbit-mail] IMAP IDLE sync error for ${accountId}:`, err)
    })
  })

  client.on('close', () => {
    runtime.client = null
    if (runtime.stopping || !idleRuntimes.has(accountId)) return
    teardownIdleConnection(accountId, provider, runtime)
  })
}

async function ensureAccountIdle(accountId: string, provider: Provider): Promise<void> {
  if (idleRuntimes.has(accountId)) return

  const runtime: IdleRuntime = {
    client: null,
    stopping: false,
    reconnectTimer: null
  }
  idleRuntimes.set(accountId, runtime)

  try {
    const client = await createImapClient(accountId, provider)
    runtime.client = client

    if (runtime.stopping) {
      await client.logout().catch(() => {})
      idleRuntimes.delete(accountId)
      return
    }

    attachIdleClientHandlers(accountId, provider, client, runtime)

    const mailboxes = await client.list()
    const inbox = findInboxMailbox(mailboxes)
    if (!inbox) {
      await client.logout().catch(() => {})
      idleRuntimes.delete(accountId)
      return
    }

    await client.mailboxOpen(inbox.path)
  } catch {
    idleRuntimes.delete(accountId)
    if (!runtime.stopping) {
      scheduleIdleReconnect(accountId, provider)
    }
  }
}

async function handleMailboxActivity(
  accountId: string,
  provider: Provider,
  client: ImapFlow
): Promise<void> {
  const mailbox = client.mailbox
  if (!mailbox?.path) return

  const folder = upsertFolder(
    accountId,
    mailbox.path,
    mailbox.name,
    detectFolderType(mailbox.name, mailbox.specialUse)
  )

  const newCount = await syncFolder(client, accountId, folder.id, mailbox.path)
  if (newCount > 0) {
    onNewMail?.()
  }
}
