/**
 * End-to-end check of the send path, through real windows.
 *
 * Run by `npm run test:send-e2e` (scripts/send-e2e.mjs), which needs Docker and
 * a display. Everything here is the app's own code: `electron/main.ts` is
 * imported whole, so the IPC handlers, the compose window and its `close`
 * handler are the real ones, not a re-implementation.
 *
 *   drafts.open -> compose renderer -> click Send -> preload ->
 *   ipcMain('compose:send') -> smtp-send -> GreenMail -> draft deleted ->
 *   Sent synced -> window closed, with no save-as-draft prompt
 *
 * `userData` is redirected to a throwaway directory *before* any app module
 * loads, so a developer's real database and accounts are never opened.
 *
 * Two traps this has already fallen into, both of which made it pass while
 * proving nothing — if a check here starts failing, suspect them first:
 *
 * - Picking windows out of `BrowserWindow.getAllWindows()` by index. The order
 *   is not creation order, and sending from the *main* window succeeds too, so
 *   the only symptom was a compose window that never closed.
 * - Opening the composer with a bare `draftId` via `compose.open`. That does not
 *   load the draft, the composer comes up empty, and its `draftIdRef` — which is
 *   what the close-time flush reads — stays null. `drafts.open` is the path
 *   "Continue editing" uses and the one that populates it.
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
  // The runner hands one over and removes it afterwards — deleting it from in
  // here, with the app still running, only lets SQLite recreate the WAL.
  const userData = process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-send-e2e-'))
  app.setPath('userData', userData)
  await app.whenReady()

  // Imported after userData is redirected. registerIpc(), createMainWindow(),
  // createComposeWindow() and every handler come from here.
  await import('../electron/main')

  const started = await waitFor(() => BrowserWindow.getAllWindows().length > 0)
  ok('main.ts starts and opens its window', started)
  if (!started) return
  const mainWin = BrowserWindow.getAllWindows()[0]

  const db = await import('../electron/services/db-service')
  const drafts = await import('../electron/services/draft-service')

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Send E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  // Sent has to exist server-side for the send to be filed into it.
  const client = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await client.connect()
  await client.mailboxCreate('Sent').catch(() => {})
  await client.logout()

  // A draft, as autosave would have left one. Its id is what the close-time
  // flush hands back, and a send deletes the row — the combination that used to
  // ask "Save this message as a draft?" about a message already sent.
  const subject = `E2E send ${process.pid}`
  const draftId = drafts.saveDraft({
    accountId: account.id,
    to: EMAIL,
    subject,
    bodyText: 'sent by the end-to-end check',
    bodyHtml: '<p>sent by the end-to-end check</p>'
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

  let composeClosed = false
  composeWin.on('closed', () => { composeClosed = true })
  if (composeWin.webContents.isLoading()) {
    await new Promise((r) => composeWin.webContents.once('did-finish-load', () => r(null)))
  }

  const readComposer = () => composeWin.webContents.executeJavaScript(
    `(() => {
       const field = [...document.querySelectorAll('.compose-field')].find(
         (f) => f.querySelector('.compose-label') &&
                f.querySelector('.compose-label').textContent.trim() === 'Subject')
       const subj = field && field.querySelector('input')
       const send = [...document.querySelectorAll('button')]
         .find((b) => b.textContent.trim() === 'Send')
       return {
         subject: subj && subj.value,
         hasSend: !!send,
         flush: typeof window.__orbitMailFlushDraft
       }
     })()`, true
  )
  // compose:open arrives after the window is shown, so let React render it
  // before deciding the composer is empty.
  let composer = await readComposer()
  for (let i = 0; i < 50 && composer.subject !== subject; i++) {
    await sleep(100)
    composer = await readComposer()
  }
  ok('the composer loads the draft it was opened with',
    composer.subject === subject, JSON.stringify(composer))
  ok('the close-time flush hook is installed', composer.flush === 'function')
  ok('the Send button is there', composer.hasSend === true)

  // The real button, so this goes through the component's own handleSend.
  await composeWin.webContents.executeJavaScript(
    `[...document.querySelectorAll('button')]
       .find((b) => b.textContent.trim() === 'Send').click()`, true
  )

  ok('the compose window closes after the send', await waitFor(() => composeClosed))
  ok('the main window is left alone', BrowserWindow.getAllWindows().length === 1,
    `${BrowserWindow.getAllWindows().length} window(s) left`)
  ok('no save-as-draft question is asked', dialogs.length === 0,
    dialogs.join(' | ') || 'none')

  // A send is now *held* for a few seconds so it can be taken back. Two things
  // follow, and both are asserted rather than waited out silently:
  //
  //  - the message has NOT gone yet, which is the entire guarantee. Without
  //    this the suite would pass just as well against a build that sent
  //    immediately, and undo-send would be untested here.
  //  - the draft survives the window, because Undo has to have something to
  //    reopen. It is deleted only once the message is actually away.
  ok('the message is held rather than sent at once',
    drafts.countDrafts(account.id) === 1,
    `drafts=${drafts.countDrafts(account.id)}`)

  // Now let the hold expire. Waiting on the outcome rather than sleeping a
  // fixed 10s, so a slower machine does not make this flaky.
  const sent = await waitFor(() => drafts.countDrafts(account.id) === 0, 30_000)
  ok('the draft is gone once the hold expires and the message goes', sent,
    `count=${drafts.countDrafts(account.id)}`)

  // compose:send syncs Sent itself, so the filed copy is already in the local
  // database — read back through the app's own query, not straight off IMAP.
  const folders = db.listFolders(account.id)
  const sentFolder = folders.find((f) => f.type === 'sent' || f.name === 'Sent')
  const filedCount = () =>
    sentFolder ? db.listMessages(sentFolder.id, 50, 0).filter((m) => m.subject === subject).length : 0
  // The draft is deleted *before* the Sent sync runs — losing the draft matters
  // more than filing the copy, so that order is deliberate. It means the draft
  // disappearing is not the signal that filing has finished; wait for the copy.
  await waitFor(() => filedCount() === 1, 20_000)
  ok('the sent message is filed in Sent', filedCount() === 1, `copies=${filedCount()}`)

  // And it really left: GreenMail delivered it to the recipient, who is the
  // same test user, so the copy comes back to this INBOX.
  const check = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await check.connect()
  const lock = await check.getMailboxLock('INBOX')
  let delivered = 0
  try {
    for await (const msg of check.fetch({ all: true }, { envelope: true })) {
      if (msg.envelope?.subject === subject) delivered++
    }
  } finally {
    lock.release()
    await check.logout()
  }
  ok('the recipient receives it', delivered === 1, `delivered=${delivered}`)

  // Window and sync callbacks fire after the composer has gone; a destroyed
  // window read through an unguarded reference throws in one of them.
  await sleep(500)
  ok('nothing threw along the way', uncaught.length === 0, uncaught.join(' | ') || 'none')

  // Only when this made its own directory; the runner cleans up the one it owns.
  if (!process.env.ORBIT_TEST_USERDATA) rmSync(userData, { recursive: true, force: true })
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\n[send-e2e] harness error:', err)
    app.exit(1)
  })
