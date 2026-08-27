import { randomUUID } from 'crypto'
import { getRawSqlite } from '../db'

/**
 * Work the app owes the future.
 *
 * Three features need the same thing: a send held back so it can be undone, a
 * send timed for later, and a snoozed message due to come home. They share one
 * table and one ticker rather than three timers, because the hard parts are the
 * same for all of them — surviving a quit, and deciding what to do about
 * something that fell due while the app was closed.
 *
 * **The honest bargain.** A desktop client has no server-side scheduler, so
 * nothing happens while the app is shut. Anything overdue runs at the next
 * start instead. That is stated in the UI rather than hidden: a scheduled send
 * says it needs the app open, and a snooze that returns late returns late
 * rather than silently never.
 */

export type ScheduledKind = 'send' | 'snooze'

export interface ScheduledAction {
  id: string
  accountId: string
  kind: ScheduledKind
  dueAt: number
  /** Kind-specific JSON, parsed by whoever registered the handler. */
  payload: unknown
  createdAt: number
}

interface Row {
  id: string
  account_id: string
  kind: ScheduledKind
  due_at: number
  payload: string
  created_at: number
}

function toAction(row: Row): ScheduledAction {
  let payload: unknown = null
  try {
    payload = JSON.parse(row.payload)
  } catch {
    // A row we cannot parse is a row we can never run. Left as null so the
    // handler rejects it and it is dropped, rather than throwing here and
    // stalling every other due action behind it.
    payload = null
  }
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    dueAt: row.due_at,
    payload,
    createdAt: row.created_at
  }
}

export function scheduleAction(input: {
  accountId: string
  kind: ScheduledKind
  dueAt: number
  payload: unknown
}): string {
  const id = randomUUID()
  getRawSqlite()
    .prepare(
      `INSERT INTO scheduled_actions (id, account_id, kind, due_at, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.accountId,
      input.kind,
      Math.round(input.dueAt),
      JSON.stringify(input.payload ?? null),
      Date.now()
    )
  return id
}

/** Returns true when there was something to cancel — which is what Undo needs. */
export function cancelAction(id: string): boolean {
  const result = getRawSqlite().prepare('DELETE FROM scheduled_actions WHERE id = ?').run(id)
  return result.changes > 0
}

export function getAction(id: string): ScheduledAction | null {
  const row = getRawSqlite()
    .prepare('SELECT * FROM scheduled_actions WHERE id = ?')
    .get(id) as Row | undefined
  return row ? toAction(row) : null
}

export function listActions(kind?: ScheduledKind): ScheduledAction[] {
  const sqlite = getRawSqlite()
  const rows = (
    kind
      ? sqlite
          .prepare('SELECT * FROM scheduled_actions WHERE kind = ? ORDER BY due_at')
          .all(kind)
      : sqlite.prepare('SELECT * FROM scheduled_actions ORDER BY due_at').all()
  ) as Row[]
  return rows.map(toAction)
}

export function dueActions(now = Date.now()): ScheduledAction[] {
  const rows = getRawSqlite()
    .prepare('SELECT * FROM scheduled_actions WHERE due_at <= ? ORDER BY due_at')
    .all(now) as Row[]
  return rows.map(toAction)
}

type Handler = (action: ScheduledAction) => Promise<void>

const handlers = new Map<ScheduledKind, Handler>()

export function registerHandler(kind: ScheduledKind, handler: Handler): void {
  handlers.set(kind, handler)
}

/** Test seam: forget the handlers so a suite can install its own. */
export function resetHandlersForTests(): void {
  handlers.clear()
}

// Guards re-entrancy: the ticker and an explicit runDueActions() can overlap,
// and running a send twice is the worst outcome this module can produce.
let running = false

/**
 * Run everything that has fallen due. Safe to call at any time; overlapping
 * calls are ignored rather than queued.
 *
 * A row is deleted **before** its handler runs. That is deliberate: a handler
 * that throws halfway — an SMTP failure after the message reached the server —
 * must not leave a row that sends it again on the next tick. Losing an action
 * is recoverable by the user; sending twice is not.
 */
export async function runDueActions(now = Date.now()): Promise<number> {
  if (running) return 0
  running = true
  let ran = 0
  try {
    for (const action of dueActions(now)) {
      const handler = handlers.get(action.kind)
      if (!handler) continue
      if (!cancelAction(action.id)) continue // cancelled underneath us
      try {
        await handler(action)
        ran++
      } catch (err) {
        console.warn(
          `[orbit-mail] Scheduled ${action.kind} failed and will not be retried:`,
          err
        )
      }
    }
  } finally {
    running = false
  }
  return ran
}

let ticker: ReturnType<typeof setInterval> | null = null

/**
 * Second-resolution, because the shortest thing on this table is a ten-second
 * undo-send window and a minute-resolution tick would make it feel broken.
 */
const TICK_MS = 1000

export function startScheduler(): void {
  if (ticker) return
  // Anything that fell due while the app was closed runs now.
  void runDueActions().catch(() => {})
  ticker = setInterval(() => {
    void runDueActions().catch(() => {})
  }, TICK_MS)
}

export function stopScheduler(): void {
  if (!ticker) return
  clearInterval(ticker)
  ticker = null
}
