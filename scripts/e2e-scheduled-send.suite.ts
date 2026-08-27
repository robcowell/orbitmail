/**
 * End-to-end check of scheduled send.
 *
 * The scheduler's rules are covered by `test:imap` and the preset arithmetic by
 * `test:store`. What needs a real app is the bargain the feature actually
 * makes: **a message timed for later waits in Drafts, and opening it there
 * takes it out of the queue.** Without that second half, editing a scheduled
 * message would leave the original still going out, unedited, at the old time —
 * the worst outcome available here.
 *
 *   schedule a send for later -> nothing goes -> it is in Drafts ->
 *   open it -> no longer scheduled -> nothing goes when the time passes
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
const waitFor = async (what: () => boolean | Promise<boolean>, ms = 20_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await what()) return true
    await sleep(150)
  }
  return false
}

const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  uncaught.push(String((err as Error)?.message ?? err))
})

const SUBJECT = `E2E scheduled ${process.pid}`

async function delivered(): Promise<number> {
  const client = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await client.connect()
  const lock = await client.getMailboxLock('INBOX')
  try {
    const found = (await client.search({ header: { subject: SUBJECT } }, { uid: true })) ?? []
    return Array.isArray(found) ? found.length : 0
  } catch {
    return 0
  } finally {
    lock.release()
    await client.logout().catch(() => {})
  }
}

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-sched-e2e-'))
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
  const drafts = await import('../electron/services/draft-service')
  const sched = await import('../electron/services/scheduler')

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Scheduled E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  const sendAt = Date.now() + 3_600_000
  const result = (await mainWin.webContents.executeJavaScript(
    `window.orbitMail.compose.scheduleSend(${JSON.stringify({
      accountId: account.id,
      to: EMAIL,
      subject: SUBJECT,
      bodyText: 'timed for later',
      bodyHtml: '<p>timed for later</p>'
    })}, ${sendAt})`, true
  )) as { scheduledId: string; dueAt: number; draftId: string | null }

  ok('the send is accepted and timed for later', result.dueAt === sendAt,
    `dueAt=${result.dueAt} sendAt=${sendAt}`)
  ok('and it is held as a draft, which is where it can be seen',
    !!result.draftId && drafts.countDrafts(account.id) === 1,
    `draftId=${result.draftId} count=${drafts.countDrafts(account.id)}`)

  // Nothing goes now. Ten seconds is the undo window for an ordinary send, so
  // wait past it: a scheduled send that quietly used the hold instead of the
  // chosen time would otherwise slip through.
  await sleep(12_000)
  ok('nothing is sent in the meantime', (await delivered()) === 0,
    `delivered=${await delivered()}`)
  ok('and the action is still waiting', sched.listActions('send').length === 1,
    JSON.stringify(sched.listActions('send').map((a) => a.dueAt)))

  // The bargain: opening it for editing takes it out of the queue.
  await mainWin.webContents.executeJavaScript(
    `window.orbitMail.drafts.open(${JSON.stringify(result.draftId)})`, true
  )
  await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  ok('opening the draft takes it out of the send queue',
    sched.listActions('send').length === 0,
    JSON.stringify(sched.listActions('send')))
  ok('and the draft is still there to edit', drafts.countDrafts(account.id) === 1,
    `count=${drafts.countDrafts(account.id)}`)

  // The proof that unscheduling was real: let its time pass and check nothing
  // goes. Asserting only that the row vanished would not catch a send that had
  // already been handed to something else.
  await sched.runDueActions(sendAt + 1000)
  await sleep(1500)
  ok('and when its time comes, nothing is sent', (await delivered()) === 0,
    `delivered=${await delivered()}`)

  for (const win of BrowserWindow.getAllWindows()) {
    if (win !== mainWin) win.destroy()
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
