/**
 * End-to-end check that a message which **was sent** but whose Sent copy could
 * not be filed tells the user, through real windows.
 *
 * This is the quietest failure the app had. `appendToSentFolder` throwing is
 * caught in `smtp-send.ts` and reduced to a `console.warn` — deliberately,
 * because the message is already delivered and failing the send would tempt the
 * user into sending it twice — and `syncSentFolder` failing is caught in
 * `main.ts` with a bare `catch {}`. Between them, an account whose Sent folder
 * was named `sent-mail` sent mail for weeks with every copy unfiled and nothing
 * on screen ever saying so. The user's report was "I can't see it in sent
 * items", and the diagnosis took a database dump.
 *
 *   drafts.open -> composer -> click Send -> held -> scheduler runs it ->
 *   SMTP delivers -> IMAP APPEND fails -> the main window's toast
 *
 * The account's **incoming** server points at port 1, which is reserved and has
 * nothing listening, while outgoing stays real. That is the exact shape of the
 * bug: the send succeeds and the file does not. It fails as a refused connection
 * rather than as a missing mailbox — GreenMail creates a mailbox on APPEND, so
 * "no Sent folder" cannot be produced here; that wording is covered by
 * `npm run test:pure`, and what needs a window is whether *any* of it arrives.
 *
 * Asserting on the toast text in the main window, not on an IPC message or a
 * return value, because "the user is told" is the entire thing under test. The
 * delivery half is checked against the **server**, with a second client on the
 * real port: the toast promises the recipient has the message, and a promise the
 * suite does not check is one the app can quietly stop keeping.
 */
import { app, dialog, BrowserWindow } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ImapFlow } from 'imapflow'

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
const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  uncaught.push(String((err as Error)?.message ?? err))
})

// Nothing here can answer a modal, and a save-as-draft prompt would mean the
// send never happened at all.
const dialogs: string[] = []
;(dialog as unknown as Record<string, unknown>).showMessageBox = async (...args: unknown[]) => {
  const opts = args[args.length - 1] as { message?: string }
  dialogs.push(opts?.message ?? '(no message)')
  return { response: 0, checkboxChecked: false }
}

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-sentcopy-e2e-'))
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

  // Outgoing is real, so the message genuinely goes out. Incoming points at a
  // reserved port with nothing on it, so the APPEND that files the copy cannot
  // succeed however long it waits.
  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Sent Copy E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: 1, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  const subject = `E2E sent copy failure ${process.pid}`
  const draftId = drafts.saveDraft({
    accountId: account.id,
    to: EMAIL,
    subject,
    bodyText: 'this one goes out but is not filed',
    bodyHtml: '<p>this one goes out but is not filed</p>'
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

  // The composer must have actually loaded the draft. A Send click on an empty
  // composer has passed this shape of suite before while proving nothing.
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

  const readToast = () => mainWin.webContents.executeJavaScript(
    `(() => {
       const t = document.querySelector('.toast');
       return t ? t.textContent : null;
     })()`, true
  ) as Promise<string | null>

  // Wait out the undo hold, then the send and the failing APPEND. Polled rather
  // than slept: a connection refusal is immediate, but a loaded machine can
  // stretch the hold.
  let toast: string | null = null
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    toast = await readToast()
    if (toast && toast.includes('no copy was saved to Sent')) break
    await sleep(250)
  }

  ok('the failure reaches the user at all — the whole point',
    !!toast && toast.includes('no copy was saved to Sent'), JSON.stringify(toast))
  // The ordering is the substance, not the style. Read as "not sent", this
  // toast costs the recipient a duplicate.
  ok('and it leads with the message having been sent',
    !!toast && /^Message sent, but/.test(toast.trim()), JSON.stringify(toast))
  ok('and never says the message was not sent',
    !!toast && !/Not sent/.test(toast), JSON.stringify(toast))
  ok('and says why, in the app’s own words rather than "Command failed"',
    !!toast && /incoming server refused the connection/.test(toast), JSON.stringify(toast))

  // The promise the toast makes about delivery, checked against the server.
  const check = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await check.connect()
  let delivered = 0
  const lock = await check.getMailboxLock('INBOX')
  try {
    for await (const msg of check.fetch({ all: true }, { envelope: true })) {
      if (msg.envelope?.subject === subject) delivered++
    }
  } finally {
    lock.release()
  }
  await check.logout()
  ok('the message really was delivered, which is what the toast promises',
    delivered === 1, `delivered=${delivered}`)

  // A send that went out is still a send: the draft is gone, because
  // performSend deletes it once sendMail resolves and a failed *file* does not
  // make sendMail reject.
  ok('the draft is gone, because the message did go',
    drafts.countDrafts(account.id) === 0, `count=${drafts.countDrafts(account.id)}`)
  ok('and no save-as-draft prompt was raised',
    dialogs.length === 0, dialogs.join(' | ') || 'none')

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
    console.error('\n[sent-copy-failure-e2e] harness error:', err)
    app.exit(1)
  })
