/**
 * End-to-end check that a sender cannot push this app's own controls off-screen.
 *
 * Message bodies are attacker-controlled HTML. Before this, nothing constrained
 * their width: `.pane-reader` has `overflow-y: auto`, which makes `overflow-x`
 * compute to `auto` as well, so a wide table scrolled the **whole pane** — the
 * subject line and the Reply buttons went with it.
 *
 * There is no way to test this without a window. The stubbed preview cannot
 * render a real message, and `test:imap` has no layout at all.
 *
 *   sync a message full of hostile-width content -> open it ->
 *   the pane does not scroll sideways, the app does not scroll sideways,
 *   and the Reply button is still where it was
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

const SUBJECT = `E2E overflow ${process.pid}`

// Every shape that has ever widened a mail client: a table too wide to reflow,
// an image sized in pixels by the sender, an unbreakable URL, and a long
// preformatted run.
const HOSTILE_BODY =
  '<table><tr>' +
  Array.from({ length: 40 }, (_, i) => `<td>column ${i} is wide</td>`).join('') +
  '</tr></table>' +
  '<p>https://tracker.example.com/' + 'x'.repeat(400) + '</p>' +
  '<pre>' + 'y'.repeat(500) + '</pre>' +
  '<img src="https://example.com/wide.png" width="3000" height="20" alt="wide">'

async function main(): Promise<void> {
  const userData =
    process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-overflow-e2e-'))
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

  const client = new ImapFlow({
    host: HOST, port: IMAP_PORT, secure: false,
    auth: { user: LOGIN, pass: PASSWORD }, logger: false
  })
  await client.connect()
  await client.append(
    'INBOX',
    Buffer.from(
      `From: Newsletter <news@example.com>\r\n` +
      `To: ${EMAIL}\r\n` +
      `Subject: ${SUBJECT}\r\n` +
      `Message-ID: <e2e-overflow-${process.pid}@example.com>\r\n` +
      `Date: ${new Date().toUTCString()}\r\n` +
      `Content-Type: text/html; charset=utf-8\r\n\r\n` +
      HOSTILE_BODY + `\r\n`
    ),
    ['\\Seen']
  )
  await client.logout().catch(() => {})

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Overflow E2E',
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
  await sleep(1500)

  const opened = await waitFor(async () => {
    await mainWin.webContents.executeJavaScript(
      `(() => { const r = document.querySelector('.message-row, [class*="thread-row"]'); if (r) r.click(); return !!r })()`,
      true
    )
    await sleep(400)
    return mainWin.webContents.executeJavaScript(`!!document.querySelector('.reader-body')`, true)
  })
  ok('the hostile message opens in the reader', opened)
  if (!opened) return
  await sleep(800)

  const measure = () =>
    mainWin.webContents.executeJavaScript(
      `(() => {
         const pane = document.querySelector('.pane-reader');
         const body = document.querySelector('.reader-body');
         const doc = document.documentElement;
         const reply = [...document.querySelectorAll('button')]
           .find((b) => /^Reply$/.test((b.textContent || '').trim()));
         return {
           // Content wider than the client box, whether or not the user could
           // scroll to it: with overflow-x hidden it is simply clipped, which
           // is no better — the controls are off the pane either way.
           paneOverflows: pane.scrollWidth > pane.clientWidth + 1,
           // Whether the wide content can actually be *reached*, not merely
           // whether it is wider. scrollWidth exceeding clientWidth is true
           // even when the content is clipped and unreachable — the same
           // conflation that made the pane check meaningless a moment ago.
           bodyReachable: (() => {
             const start = body.scrollLeft;
             body.scrollLeft = 9999;
             const moved = body.scrollLeft > start;
             body.scrollLeft = start;
             return moved;
           })(),
           appScrolls: doc.scrollWidth > window.innerWidth + 1,
           replyLeft: reply ? Math.round(reply.getBoundingClientRect().left) : null,
           paneLeft: Math.round(pane.getBoundingClientRect().left)
         };
       })()`, true
    ) as Promise<{
      paneOverflows: boolean
      bodyReachable: boolean
      appScrolls: boolean
      replyLeft: number | null
      paneLeft: number
    }>

  const before = await measure()

  // The pane must not scroll sideways; the body may, because a table cannot
  // reflow and scrolling it is better than clipping it.
  ok('nothing in the reader pane is wider than the pane', before.paneOverflows === false,
    JSON.stringify(before))
  ok('the app does not scroll sideways', before.appScrolls === false, JSON.stringify(before))
  ok('and the wide content can still be reached, by scrolling the body itself',
    before.bodyReachable === true, JSON.stringify(before))

  // The assertion that says what this is really about: scrolling the message
  // must not move the app's own controls.
  await mainWin.webContents.executeJavaScript(
    `document.querySelector('.reader-body').scrollLeft = 99999`, true
  )
  await sleep(400)
  const after = await measure()
  ok('scrolling the wide content leaves the Reply button where it was',
    before.replyLeft !== null && after.replyLeft === before.replyLeft,
    `before=${before.replyLeft} after=${after.replyLeft}`)

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
