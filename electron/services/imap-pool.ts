import type { ImapFlow } from 'imapflow'
import type { Provider } from '../../shared/types'
import { createImapClient } from './imap-sync'

// A per-account pooled IMAP client. Every server op used to be a full
// connect+auth+logout cycle, so marking N messages meant N connections. Instead
// we keep one client per account alive between operations, serialize operations
// per account (imapflow is single-op-at-a-time), and close the client after a
// short idle period.
//
// This pool is deliberately separate from the IDLE monitor's persistent client
// (imap-idle.ts): IDLE holds the inbox in a push state, and borrowing it for
// arbitrary mutations would fight that. Two connections per account is an
// acceptable trade for keeping IDLE and mutation/sync paths independent.

const IDLE_CLOSE_MS = 30_000

interface Lane {
  // Promise chain that serializes operations for this account.
  chain: Promise<unknown>
  client: ImapFlow | null
  provider: Provider
  idleTimer: ReturnType<typeof setTimeout> | null
}

const lanes = new Map<string, Lane>()

function getLane(accountId: string, provider: Provider): Lane {
  let lane = lanes.get(accountId)
  if (!lane) {
    lane = { chain: Promise.resolve(), client: null, provider, idleTimer: null }
    lanes.set(accountId, lane)
  } else {
    lane.provider = provider
  }
  return lane
}

function clearIdleTimer(lane: Lane): void {
  if (lane.idleTimer) {
    clearTimeout(lane.idleTimer)
    lane.idleTimer = null
  }
}

async function closeLaneClient(lane: Lane): Promise<void> {
  const client = lane.client
  lane.client = null
  if (!client) return
  try {
    await client.logout()
  } catch {
    try {
      client.close()
    } catch {
      // already gone
    }
  }
}

function scheduleIdleClose(accountId: string, lane: Lane): void {
  clearIdleTimer(lane)
  lane.idleTimer = setTimeout(() => {
    lane.idleTimer = null
    void closeLaneClient(lane)
  }, IDLE_CLOSE_MS)
}

function attachHandlers(accountId: string, lane: Lane, client: ImapFlow): void {
  const drop = () => {
    if (lane.client === client) lane.client = null
  }
  client.on('close', drop)
  client.on('error', () => {
    // 'close' follows an error; swallow here so it doesn't become an
    // unhandled 'error' event on the EventEmitter.
  })
}

/**
 * Borrow the account's pooled IMAP client for a single operation. Operations on
 * the same account are serialized; the client is created on demand and reused
 * across calls, then closed after `IDLE_CLOSE_MS` of inactivity. If `fn` throws
 * (often a dropped connection), the client is closed so the next call reconnects.
 */
export function withImapClient<T>(
  accountId: string,
  provider: Provider,
  fn: (client: ImapFlow) => Promise<T>
): Promise<T> {
  const lane = getLane(accountId, provider)

  const run = async (): Promise<T> => {
    clearIdleTimer(lane)
    if (!lane.client || !lane.client.usable) {
      lane.client = await createImapClient(accountId, provider)
      attachHandlers(accountId, lane, lane.client)
    }
    try {
      return await fn(lane.client)
    } catch (err) {
      await closeLaneClient(lane)
      throw err
    } finally {
      scheduleIdleClose(accountId, lane)
    }
  }

  // Queue behind any in-flight op for this account, regardless of its outcome.
  const result = lane.chain.then(run, run)
  lane.chain = result.catch(() => {})
  return result
}

/** Close and forget a single account's pooled connection (e.g. on removal). */
export async function closeAccountPool(accountId: string): Promise<void> {
  const lane = lanes.get(accountId)
  if (!lane) return
  clearIdleTimer(lane)
  lanes.delete(accountId)
  await closeLaneClient(lane)
}

/** Close every pooled connection (app shutdown). */
export async function closeAllPools(): Promise<void> {
  const all = Array.from(lanes.values())
  lanes.clear()
  await Promise.all(
    all.map((lane) => {
      clearIdleTimer(lane)
      return closeLaneClient(lane)
    })
  )
}
