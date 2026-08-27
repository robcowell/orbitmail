/**
 * End-to-end check of the reader's keyboard shortcuts, through real keystrokes.
 *
 * Same rationale as the zoom suite: whether a key *reaches* the handler cannot
 * be answered without a window. The reply-all compose mode has existed all
 * along and the reader has always had the button — only the key was missing, on
 * one of the most-used actions in work mail.
 *
 *   sync a message with several recipients -> select it -> press `a` ->
 *   a compose window opens in reply-all mode, addressed to everyone but us
 *
 * The check that matters is the last clause. A reply-all that quietly addresses
 * only the sender is worse than no shortcut at all: it looks like it worked, and
 * the people who needed the reply never see it. So this asserts on the
 * composer's actual To/Cc, not merely on a window having opened.
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

const SUBJECT = `E2E shortcuts ${process.pid}`

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-shortcuts-e2e-'))
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

  // Several recipients besides us, which is the whole point of reply-all.
  const client = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await client.connect()
  await client.append(
    'INBOX',
    Buffer.from(
      `From: Jan <jan@example.com>\r\n` +
      `To: ${EMAIL}, Priya <priya@example.com>\r\n` +
      `Cc: Sam <sam@example.com>\r\n` +
      `Subject: ${SUBJECT}\r\n` +
      `Message-ID: <e2e-shortcuts-${process.pid}@example.com>\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `\r\n` +
      `Everyone on this thread should get the reply.\r\n`
    ),
    ['\\Seen']
  )
  await client.logout().catch(() => {})

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Shortcuts E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  await sync.refreshAccount(account.id, 'imap')

  const inbox = db.listFolders(account.id).find((f) => f.type === 'inbox')
  ok('the account has an inbox', !!inbox)
  if (!inbox) return

  await mainWin.webContents.executeJavaScript(
    `window.orbitMail.preferences.saveUi({ selectedFolderId: ${JSON.stringify(inbox.id)} })`,
    true
  )
  await mainWin.webContents.reload()
  await new Promise((r) => mainWin.webContents.once('did-finish-load', () => r(null)))
  await sleep(1200)

  const rowAppeared = await waitFor(() =>
    mainWin.webContents.executeJavaScript(
      `!!document.querySelector('.message-row, [class*="thread-row"]')`, true
    )
  )
  ok('the conversation is listed', rowAppeared)
  if (!rowAppeared) return

  // Select it, and give React a tick — clicking and acting in one evaluated
  // block selects nothing, which is how the undo suite first proved nothing.
  await mainWin.webContents.executeJavaScript(
    `document.querySelector('.message-row, [class*="thread-row"]').click()`, true
  )
  const opened = await waitFor(() =>
    mainWin.webContents.executeJavaScript(
      `!!document.querySelector('[class*="reader"], [class*="message-view"]')`, true
    )
  )
  ok('the reader opens the conversation', opened)
  if (!opened) return

  const windowsBefore = BrowserWindow.getAllWindows().length

  // A real keystroke, delivered the way Chromium would. Not a synthetic
  // KeyboardEvent: the point is that the key reaches the handler at all.
  mainWin.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'a' })
  mainWin.webContents.sendInputEvent({ type: 'char', keyCode: 'a' })
  mainWin.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'a' })

  const composeOpened = await waitFor(
    () => BrowserWindow.getAllWindows().length > windowsBefore
  )
  ok('pressing `a` opens a composer', composeOpened)
  if (!composeOpened) return

  const composeWin = BrowserWindow.getAllWindows().find((w) => w !== mainWin)
  ok('the composer is the window that is not the main one', !!composeWin)
  if (!composeWin) return
  if (composeWin.webContents.isLoading()) {
    await new Promise((r) => composeWin.webContents.once('did-finish-load', () => r(null)))
  }
  await sleep(800)

  const fields = await composeWin.webContents.executeJavaScript(
    `(() => {
       const read = (label) => {
         const field = [...document.querySelectorAll('.compose-field')].find(
           (f) => f.querySelector('.compose-label') &&
                  f.querySelector('.compose-label').textContent.trim() === label);
         if (!field) return null;
         const input = field.querySelector('input');
         const tokens = [...field.querySelectorAll('[class*="token"]')]
           .map((t) => t.textContent.trim());
         return { value: input ? input.value : '', tokens: tokens };
       };
       return { to: read('To'), cc: read('Cc'), subject: read('Subject') };
     })()`, true
  ) as {
    to: { value: string; tokens: string[] } | null
    cc: { value: string; tokens: string[] } | null
    subject: { value: string; tokens: string[] } | null
  }

  const all = JSON.stringify(fields)
  ok('the composer is a reply — the subject carries the original',
    (fields.subject?.value ?? '').includes(SUBJECT), fields.subject?.value ?? '(none)')

  // The assertion this suite exists for: everyone on the thread, not just the
  // sender. A reply-all that quietly drops the others looks like it worked.
  ok('reply-all addresses the original sender', /jan@example\.com/.test(all), all.slice(0, 200))
  ok('and the other To recipient', /priya@example\.com/.test(all), all.slice(0, 200))
  ok('and whoever was copied', /sam@example\.com/.test(all), all.slice(0, 200))
  ok('but not us — replying to yourself is not reply-all',
    !new RegExp(EMAIL.replace('.', '\\.')).test(all), all.slice(0, 200))

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
