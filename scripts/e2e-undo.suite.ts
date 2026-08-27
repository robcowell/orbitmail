/**
 * End-to-end check of undo, through a real window.
 *
 * This is the one thing `test:store` and `test:imap` structurally cannot reach.
 * `buildUndo` is pure and covered under plain node; `findMessagesByRfcId` is
 * covered in the windowless suite. Neither can answer the question that actually
 * matters: **does clicking Undo put the mail back?** That needs a rendered
 * toast, a real click, and a mail server to check afterwards.
 *
 *   sync a message into INBOX -> select it -> click the real Delete button ->
 *   message moves to Trash on the server -> toast renders with an Undo button ->
 *   click it -> messages:undoRelocate -> message is back in INBOX, on the server
 *
 * `userData` is redirected to a throwaway directory *before* any app module
 * loads, so a developer's real database and accounts are never opened.
 *
 * The trap this suite is written against, and the reason it asserts on the
 * server rather than only on the local rows: a move does **not** preserve the
 * local row. The message is deleted locally, moved on the server, and
 * re-imported by the next poll under a new uid and a new id. A check that only
 * looked at local state could pass while the mail sat in Trash forever.
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

// main.ts installs its own uncaughtException handler, so a throw in a window or
// a sync callback does not stop the process — it just disappears into the log.
const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  uncaught.push(String((err as Error)?.message ?? err))
})

const SUBJECT = `E2E undo ${process.pid}`
const RFC_ID = `<e2e-undo-${process.pid}@example.com>`

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

/** How many messages with our subject sit in a given mailbox, server-side. */
async function countOnServer(mailbox: string): Promise<number> {
  return withClient(async (client) => {
    const lock = await client.getMailboxLock(mailbox)
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
  const userData = process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-undo-e2e-'))
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

  // Trash has to exist server-side before the account syncs, or the app has no
  // trash folder to delete into and the delete becomes an outright expunge —
  // which is precisely the case undo cannot reverse.
  await withClient(async (client) => {
    await client.mailboxCreate('Trash').catch(() => {})
    await client.append(
      'INBOX',
      Buffer.from(
        `From: Someone <someone@example.com>\r\n` +
        `To: ${EMAIL}\r\n` +
        `Subject: ${SUBJECT}\r\n` +
        `Message-ID: ${RFC_ID}\r\n` +
        `Date: ${new Date().toUTCString()}\r\n` +
        `\r\n` +
        `The body of a message that is about to be deleted and put back.\r\n`
      ),
      ['\\Seen']
    )
  })

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Undo E2E',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  } as never)

  await sync.refreshAccount(account.id, 'imap')

  const inboxFolder = db.listFolders(account.id).find((f) => f.type === 'inbox')
  const trashFolder = db.listFolders(account.id).find((f) => f.type === 'trash')
  ok('the account has both an inbox and a trash folder',
    !!inboxFolder && !!trashFolder,
    `inbox=${!!inboxFolder} trash=${!!trashFolder}`)
  if (!inboxFolder || !trashFolder) return

  const localInInbox = () =>
    db.searchMessages(SUBJECT, account.id).filter((m) => m.folderId === inboxFolder.id).length

  ok('the message synced into the inbox', localInInbox() === 1, `count=${localInInbox()}`)
  ok('and it is in INBOX on the server', (await countOnServer('INBOX')) === 1)

  // Point the renderer at the inbox and let it load, so the row it deletes is a
  // real row in a real list rather than something poked into the store.
  await mainWin.webContents.executeJavaScript(
    `(async () => {
       const s = window.orbitMail;
       await s.preferences.saveUi({ selectedFolderId: ${JSON.stringify(inboxFolder.id)} });
     })()`, true
  )
  await mainWin.webContents.reload()
  await new Promise((r) => mainWin.webContents.once('did-finish-load', () => r(null)))
  await sleep(1200)

  const rowAppeared = await waitFor(() =>
    mainWin.webContents.executeJavaScript(
      `!!document.querySelector('.message-row, [class*="thread-row"]')`, true
    )
  )
  ok('the conversation is listed in the window', rowAppeared)
  if (!rowAppeared) return

  // Select the row, then click the real Delete button — as two steps with a
  // wait between them. Doing both in one evaluated block selects nothing: React
  // has not re-rendered by the time the second line runs, so the toolbar button
  // is still disabled and `.click()` on it is silently a no-op. That is exactly
  // how this suite first "passed the click" while deleting nothing.
  await mainWin.webContents.executeJavaScript(
    `document.querySelector('.message-row, [class*="thread-row"]').click()`, true
  )

  const selected = await waitFor(() =>
    mainWin.webContents.executeJavaScript(
      `(() => {
         const del = [...document.querySelectorAll('button')]
           .find((b) => (b.getAttribute('title') || '') === 'Delete');
         return !!del && del.disabled === false;
       })()`, true
    )
  )
  ok('selecting a conversation enables the toolbar Delete button', selected)
  if (!selected) return

  const clicked = await mainWin.webContents.executeJavaScript(
    `(() => {
       const del = [...document.querySelectorAll('button')]
         .find((b) => (b.getAttribute('title') || '') === 'Delete');
       del.click();
       return true;
     })()`, true
  ) as boolean
  ok('the Delete button is clicked', clicked === true)

  // The delete is a server round-trip, so give it time to land.
  const movedOnServer = await waitFor(async () => (await countOnServer('Trash')) === 1, 25_000)
  ok('the message reaches Trash on the server', movedOnServer,
    `trash=${await countOnServer('Trash')} inbox=${await countOnServer('INBOX')}`)
  ok('and is no longer in INBOX on the server', (await countOnServer('INBOX')) === 0)

  // The toast, with a real Undo button in it. This is the check that fails
  // outright on a build without undo: the toast is a bare string there.
  const toast = await waitFor(() =>
    mainWin.webContents.executeJavaScript(`!!document.querySelector('.toast-action')`, true)
  )
  ok('the toast offers Undo', toast)
  if (!toast) return

  const toastText = await mainWin.webContents.executeJavaScript(
    `(document.querySelector('.toast') || {}).textContent || ''`, true
  ) as string
  ok('and the toast says what it is offering to undo',
    /delete/i.test(toastText), JSON.stringify(toastText.trim()))

  // Click it — the actual button, not the store action behind it.
  await mainWin.webContents.executeJavaScript(
    `document.querySelector('.toast-action').click()`, true
  )

  // The message has to come back on the **server**, not merely in a local row.
  const restored = await waitFor(async () => (await countOnServer('INBOX')) === 1, 30_000)
  ok('clicking Undo puts the message back in INBOX on the server', restored,
    `inbox=${await countOnServer('INBOX')} trash=${await countOnServer('Trash')}`)
  ok('and it is out of Trash again', (await countOnServer('Trash')) === 0,
    `trash=${await countOnServer('Trash')}`)

  // Local state has to agree, or the list would keep showing it in the wrong
  // place until the next sync.
  await sync.refreshAccount(account.id, 'imap').catch(() => {})
  const backLocally = await waitFor(() => localInInbox() === 1, 15_000)
  ok('the local row is back in the inbox too', backLocally, `count=${localInInbox()}`)

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
