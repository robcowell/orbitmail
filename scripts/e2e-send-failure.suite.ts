/**
 * End-to-end check that a send which **fails** tells the user, through real
 * windows.
 *
 * The send runs on the scheduler after the undo window closes, long after the
 * composer has gone. When it threw, the scheduler logged
 * "Scheduled send failed and will not be retried" and stopped there: the row is
 * deleted before the handler runs and is never retried, the draft survived, and
 * nothing on screen said any of it. The last thing the user saw was the send
 * being accepted. A message silently not sent is the worst failure this app
 * has, and no unit test can see it — the whole defect is that nothing reached
 * the window.
 *
 *   drafts.open -> composer -> click Send -> held -> scheduler runs it ->
 *   SMTP refuses -> compose:sendFailed -> the main window's toast
 *
 * The account's outgoing server points at port 1, which is reserved and has
 * nothing listening: a deterministic failure needing no fault injection, and the
 * incoming side stays real so everything up to the send behaves normally.
 *
 * This asserts on the **toast text in the main window**, not on an IPC message
 * or a store field, because "the user is told" is the entire thing under test.
 */
import { app, dialog, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// No display means no GPU process to talk to, and Electron takes a SIGSEGV on
// the way down. The runner refuses to start without one, but this costs nothing.
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
const waitFor = async (what: () => boolean, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (what()) return true
    await sleep(100)
  }
  return false
}

// main.ts installs its own uncaughtException handler, so a throw in a window or
// sync callback does not stop the process — it just disappears into the log.
// Recorded here so it can be asserted on instead.
const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  uncaught.push(String((err as Error)?.message ?? err))
})

// Recorded rather than shown: nothing here can answer a modal, and whether the
// save-as-draft question is asked at all is one of the things under test.
const dialogs: string[] = []
;(dialog as unknown as Record<string, unknown>).showMessageBox = async (...args: unknown[]) => {
  const opts = args[args.length - 1] as { message?: string }
  dialogs.push(opts?.message ?? '(no message)')
  return { response: 0, checkboxChecked: false }
}

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-sendfail-e2e-'))
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

  // Incoming is real; outgoing points at a reserved port with nothing on it, so
  // the send cannot succeed however long it waits.
  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Send Failure E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: 1, security: 'none' }
  } as never)

  const subject = `E2E send failure ${process.pid}`
  const draftId = drafts.saveDraft({
    accountId: account.id,
    to: EMAIL,
    subject,
    bodyText: 'this one cannot go out',
    bodyHtml: '<p>this one cannot go out</p>'
  })
  ok('a draft exists before the send',
    !!draftId && drafts.countDrafts(account.id) === 1,
    `count=${drafts.countDrafts(account.id)}`)

  await mainWin.webContents.executeJavaScript(
    `window.orbitMail.drafts.open(${JSON.stringify(draftId)})`, true
  )
  const opened = await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  ok('the compose window opens', opened)
  if (!opened) return

  const composeWin = BrowserWindow.getAllWindows().find((w) => w !== mainWin)
  ok('the compose window is the one that is not the main window', !!composeWin)
  if (!composeWin) return
  if (composeWin.webContents.isLoading()) {
    await new Promise((r) => composeWin.webContents.once('did-finish-load', () => r(null)))
  }

  const readComposer = () => composeWin.webContents.executeJavaScript(
    `(() => {
       const field = [...document.querySelectorAll('.compose-field')].find(
         (f) => f.querySelector('.compose-label') &&
                f.querySelector('.compose-label').textContent.trim() === 'Subject')
       const subj = field && field.querySelector('input')
       return { subject: subj && subj.value }
     })()`, true
  )
  let composer = await readComposer()
  for (let i = 0; i < 50 && composer.subject !== subject; i++) {
    await sleep(100)
    composer = await readComposer()
  }
  ok('the composer loads the draft it was opened with',
    composer.subject === subject, JSON.stringify(composer))

  await composeWin.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')]
       .find((b) => b.textContent.trim() === 'Send').click()`, true
  )
  ok('the compose window closes after Send', await waitFor(
    () => BrowserWindow.getAllWindows().length === 1))

  // The toast the user actually reads, from the main window's own DOM.
  const readToast = () => mainWin.webContents.executeJavaScript(
    `(() => {
       const t = document.querySelector('.toast');
       return t ? t.textContent : null;
     })()`, true
  ) as Promise<string | null>

  // Wait out the undo hold, then the failing SMTP attempt. Polled rather than
  // slept: the hold is seconds and a connection refusal is immediate, but a
  // loaded machine can stretch both.
  let toast: string | null = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    toast = await readToast()
    if (toast && toast.includes('Not sent')) break
    await sleep(250)
  }

  ok('the failure reaches the user at all — the whole point',
    !!toast && toast.includes('Not sent'), JSON.stringify(toast))
  ok('and says the outgoing server refused the connection, not "Command failed"',
    !!toast && /outgoing server refused the connection/.test(toast), JSON.stringify(toast))
  ok('and says the message was kept',
    !!toast && toast.includes('still in Drafts'), JSON.stringify(toast))

  // The promise the toast makes has to be true.
  ok('the draft really is still there',
    drafts.countDrafts(account.id) === 1, `count=${drafts.countDrafts(account.id)}`)

  // A failed send must not look like a successful one.
  const folders = db.listFolders(account.id)
  const sentFolder = folders.find((f) => f.type === 'sent' || f.name === 'Sent')
  const filed = sentFolder
    ? db.listMessages(sentFolder.id, 50, 0).filter((m) => m.subject === subject).length
    : 0
  ok('nothing was filed in Sent', filed === 0, `copies=${filed}`)

  await sleep(500)
  ok('nothing threw along the way', uncaught.length === 0, uncaught.join(' | ') || 'none')

  if (!process.env.ORBIT_TEST_USERDATA) rmSync(userData, { recursive: true, force: true })
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\n[send-failure-e2e] harness error:', err)
    app.exit(1)
  })
