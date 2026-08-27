/**
 * End-to-end check of snooze, against a real mail server.
 *
 * The preset arithmetic is pure and covered by `test:store`; the scheduler's
 * rules are covered by `test:imap`. Neither can answer what snooze actually
 * promises: **the message leaves your inbox on the server, and comes back.**
 * That is the difference between this and a local flag, and it is only
 * observable from outside the app.
 *
 *   sync a message -> snooze it -> it is in Snoozed and gone from INBOX,
 *   on the server -> the action falls due -> it is back in INBOX
 *
 * Deliberately driven through `messages:snooze` rather than the context menu:
 * the menu is a list of presets, while the part that can silently be wrong is
 * everything after it — creating the folder, moving the mail, finding it again
 * by Message-ID once its local row no longer exists, and putting it home.
 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ImapFlow } from 'imapflow'

app.disableHardwareAcceleration()

const HOST = '127.0.0.1'
const IMAP_PORT = Number(process.env.ORBIT_TEST_IMAP_PORT ?? 3243)
const SMTP_PORT = Number(process.env.ORBIT_TEST_SMTP_PORT ?? 3225)
const EMAIL = process.env.ORBIT_TEST_EMAIL ?? 'rob@example.com'
const LOGIN = process.env.ORBIT_TEST_LOGIN ?? 'rob'
const PASSWORD = process.env.ORBIT_TEST_PASSWORD ?? 'secret'

let passed = 0
let failed = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) passed++
  else failed++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const waitFor = async (what: () => boolean | Promise<boolean>, ms = 25_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await what()) return true
    await sleep(200)
  }
  return false
}

const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  uncaught.push(String((err as Error)?.message ?? err))
})

const SUBJECT = `E2E snooze ${process.pid}`
const RFC_ID = `<e2e-snooze-${process.pid}@example.com>`

async function withClient<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => {})
  }
}

async function countOnServer(mailbox: string): Promise<number> {
  return withClient(async (client) => {
    let lock
    try {
      lock = await client.getMailboxLock(mailbox)
    } catch {
      // The mailbox may not exist yet — snoozing is what creates it.
      return 0
    }
    try {
      const found = (await client.search({ header: { subject: SUBJECT } }, { uid: true })) ?? []
      return Array.isArray(found) ? found.length : 0
    } catch {
      return 0
    } finally {
      lock.release()
    }
  })
}

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-snooze-e2e-'))
  app.setPath('userData', userData)
  await app.whenReady()

  await import('../electron/main')

  const started = await waitFor(() => BrowserWindow.getAllWindows().length > 0)
  ok('main.ts starts and opens its window', started)
  if (!started) return
  const mainWin = BrowserWindow.getAllWindows()[0]
  if (mainWin.webContents.isLoading()) {
    await new Promise((r) => mainWin.webContents.once('did-finish-load', () => r(null)))
  }

  const db = await import('../electron/services/db-service')
  const sync = await import('../electron/services/imap-sync')
  const sched = await import('../electron/services/scheduler')

  await withClient(async (client) => {
    await client.append(
      'INBOX',
      Buffer.from(
        `From: Someone <someone@example.com>\r\n` +
        `To: ${EMAIL}\r\n` +
        `Subject: ${SUBJECT}\r\n` +
        `Message-ID: ${RFC_ID}\r\n` +
        `Date: ${new Date().toUTCString()}\r\n` +
        `\r\n` +
        `See you later.\r\n`
      ),
      ['\\Seen']
    )
  })

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Snooze E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  await sync.refreshAccount(account.id, 'imap')

  const inbox = db.listFolders(account.id).find((f) => f.type === 'inbox')
  ok('the account has an inbox', !!inbox)
  if (!inbox) return

  const local = db.searchMessages(SUBJECT, account.id)
  ok('the message synced', local.length === 1, `count=${local.length}`)
  if (local.length !== 1) return
  ok('and starts in INBOX on the server', (await countOnServer('INBOX')) === 1)

  // Due far enough out that nothing fires by accident; the suite triggers it
  // deliberately below rather than waiting for a clock.
  const wakeAt = Date.now() + 3_600_000
  const result = (await mainWin.webContents.executeJavaScript(
    `window.orbitMail.messages.snooze(${JSON.stringify([local[0].id])}, ${wakeAt})`, true
  )) as { snoozed: number; failed: number }
  ok('the snooze is accepted', result.snoozed === 1 && result.failed === 0,
    JSON.stringify(result))

  // The promise snooze makes, and the reason this is a folder and not a flag:
  // the message is gone from the inbox *on the server*, so it is gone from the
  // inbox on your phone too.
  const leftInbox = await waitFor(async () => (await countOnServer('INBOX')) === 0)
  ok('the message leaves INBOX on the server', leftInbox,
    `inbox=${await countOnServer('INBOX')}`)
  // The mailbox is NOT called "Snoozed" on the wire. Servers that put new
  // mailboxes under the personal namespace create it as `INBOX.Snoozed`, which
  // is what GreenMail does — the app copes because it matches on the leaf name,
  // but a test that hardcodes the path looks at a mailbox that does not exist
  // and reports an empty folder for a message that is sitting right there.
  const snoozePath =
    db.listFolders(account.id).find((f) => f.name === 'Snoozed')?.imapPath ?? 'Snoozed'
  ok('the Snoozed folder was created on the server',
    (await withClient(async (c) => (await c.list()).some((m) => m.path === snoozePath))),
    snoozePath)

  const inSnoozed = await waitFor(async () => (await countOnServer(snoozePath)) === 1)
  ok('and is waiting in Snoozed', inSnoozed, `snoozed=${await countOnServer(snoozePath)}`)

  const pending = sched.listActions('snooze')
  ok('a scheduled action records when it is due back', pending.length === 1,
    JSON.stringify(pending.map((a) => a.dueAt)))
  ok('and it is keyed by Message-ID, not by the row that no longer exists',
    (pending[0]?.payload as { rfcMessageId?: string })?.rfcMessageId === RFC_ID,
    JSON.stringify(pending[0]?.payload))

  // Fall due. runDueActions takes the time to compare against, so this is the
  // real handler on a real schedule rather than a special test path.
  await sched.runDueActions(wakeAt + 1000)

  const cameBack = await waitFor(async () => (await countOnServer('INBOX')) === 1)
  ok('when it falls due the message is back in INBOX on the server', cameBack,
    `inbox=${await countOnServer('INBOX')} snoozed=${await countOnServer(snoozePath)}`)
  ok('and no longer in Snoozed', (await countOnServer(snoozePath)) === 0,
    `snoozed=${await countOnServer(snoozePath)}`)
  ok('the scheduled action is gone once it has run',
    sched.listActions('snooze').length === 0,
    JSON.stringify(sched.listActions('snooze')))

  // A message with no Message-ID cannot be found again when it is due, so it
  // cannot be snoozed at all — reported rather than accepted and lost.
  await withClient(async (client) => {
    await client.append(
      'INBOX',
      Buffer.from(
        `From: Someone <someone@example.com>\r\n` +
        `To: ${EMAIL}\r\n` +
        `Subject: ${SUBJECT} headerless\r\n` +
        `Date: ${new Date().toUTCString()}\r\n\r\nNo Message-ID here.\r\n`
      ),
      ['\\Seen']
    )
  })
  await sync.refreshAccount(account.id, 'imap')
  const headerless = db
    .searchMessages(`${SUBJECT} headerless`, account.id)
    .filter((m) => !m.messageId)
  if (headerless.length === 1) {
    const bad = (await mainWin.webContents.executeJavaScript(
      `window.orbitMail.messages.snooze(${JSON.stringify([headerless[0].id])}, ${Date.now() + 60_000})`,
      true
    )) as { snoozed: number; failed: number }
    ok('a message with no Message-ID is refused rather than lost',
      bad.snoozed === 0 && bad.failed === 1, JSON.stringify(bad))
  } else {
    // GreenMail may add a Message-ID of its own; then there is nothing to test.
    ok('a message with no Message-ID is refused rather than lost', true,
      'skipped — the server supplied a Message-ID')
  }

  ok('nothing threw along the way', uncaught.length === 0, uncaught.join('; ') || 'none')
}

main()
  .catch((err) => {
    failed++
    console.log(`  FAIL  suite threw — ${String((err as Error)?.message ?? err)}`)
  })
  .then(async () => {
    console.log(`\n${passed} passed, ${failed} failed`)
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    app.exit(failed === 0 ? 0 : 1)
  })
