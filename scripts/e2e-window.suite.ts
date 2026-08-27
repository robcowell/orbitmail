/**
 * Window lifecycle: the composer is an ordinary window, and nothing may use a
 * window after it has gone.
 *
 * Run by `npm run test:e2e` (scripts/e2e.mjs). Needs a display; no Docker — it
 * never talks to a mail server. A real window manager is the *point* of the
 * maximize check: Electron cannot answer it, only the WM can.
 *
 * **The composer must not be a child window.** It was created with
 * `parent: mainWindow`, which sets WM_TRANSIENT_FOR, and to Muffin/Mutter a
 * transient window is a dialog with no maximize function at all — so
 * `maximize()` did nothing, and a message could not be written full-screen.
 * Electron reported none of it: `isMaximizable()` stayed true, because the flag
 * is ours and the veto is the window manager's. Hence the check here asks the
 * WM — maximize, then read the bounds back — rather than trusting the flag.
 *
 * That parent relationship used to be the deterministic reproduction of the
 * `liveMainWindow()` bug (closing the main window destroyed the composer, whose
 * `closed` handler then called notifyMessagesUpdated() against a window that had
 * gone). Removing the parent removes that route: `mainWindow` is nulled in its
 * own `closed` handler, which now runs first, so the plain `mainWindow?.` guard
 * would survive this suite too. **`liveMainWindow()` is pinned by source-shape
 * checks in `npm run test:imap` instead** — it must check the window *and* its
 * webContents (the webContents dies first) and notifyMessagesUpdated must read
 * through it. What is left here is the close path end to end: the composer
 * outlives the main window, and neither close throws.
 */
import { app, BrowserWindow } from 'electron'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

app.disableHardwareAcceleration()

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

// main.ts installs its own uncaughtException handler, so a throw in a window
// callback does not stop the process — it just goes to the log. This is the whole
// assertion, so it is recorded here.
//
// Reported *immediately* rather than at the end, because the regression this
// exists to catch does not leave a tidy path to the end: the throw derails the
// close it happened in, and the process goes down with a second one before any
// summary can print. Without this line a failure read as three passes and a
// stack trace.
const uncaught: string[] = []
process.on('uncaughtException', (err) => {
  const message = String((err as Error)?.message ?? err)
  uncaught.push(message)
  failed++
  console.log(`  FAIL  a window or sync callback threw — ${message}`)
})

async function main(): Promise<void> {
  app.setPath('userData', process.env.ORBIT_TEST_USERDATA ?? mkdtempSync(join(tmpdir(), 'orbit-e2e-')))
  await app.whenReady()
  await import('../electron/main')

  const started = await waitFor(() => BrowserWindow.getAllWindows().length > 0)
  ok('main.ts starts and opens its window', started)
  if (!started) return
  const mainWin = BrowserWindow.getAllWindows()[0]

  // ---- Responsive panes ------------------------------------------------
  // fitPanes is pure and covered by test:store. What needs a window is whether
  // the ResizeObserver fires at all and the widths it computes actually reach
  // the DOM — before this the sidebar and list were flex-shrink:0, so the
  // reader absorbed every pixel the window lost.
  const readPanes = () =>
    mainWin.webContents.executeJavaScript(
      `(() => {
         const w = (sel) => {
           const el = document.querySelector(sel);
           return el ? Math.round(el.getBoundingClientRect().width) : null;
         };
         return {
           sidebar: w('.pane-sidebar'),
           list: w('.pane-list'),
           reader: w('.pane-reader'),
           bodyOverflows: document.documentElement.scrollWidth > window.innerWidth + 1
         };
       })()`, true
    ) as Promise<{
      sidebar: number | null
      list: number | null
      reader: number | null
      bodyOverflows: boolean
    }>

  mainWin.setBounds({ ...mainWin.getBounds(), width: 1500 })
  await sleep(700)
  const wide = await readPanes()
  ok('at 1500px all three panes are shown',
    wide.sidebar !== null && wide.list !== null && (wide.reader ?? 0) > 400,
    JSON.stringify(wide))

  // The width that used to leave the subject wrapping over three lines.
  mainWin.setBounds({ ...mainWin.getBounds(), width: 1000 })
  await sleep(700)
  const squeezed = await readPanes()
  ok('narrowing the window shrinks the list rather than crushing the reader',
    (squeezed.reader ?? 0) >= 380, JSON.stringify(squeezed))
  ok('and nothing overflows the window sideways', squeezed.bodyOverflows === false,
    JSON.stringify(squeezed))

  mainWin.setBounds({ ...mainWin.getBounds(), width: 760 })
  await sleep(700)
  const narrow = await readPanes()
  ok('below the breakpoint the sidebar is gone rather than squeezing the reader',
    narrow.sidebar === null, JSON.stringify(narrow))
  ok('the reader still has room with the sidebar hidden', (narrow.reader ?? 0) >= 380,
    JSON.stringify(narrow))
  ok('and still nothing overflows sideways', narrow.bodyOverflows === false,
    JSON.stringify(narrow))

  // Widening brings it back on its own — a collapse the user cannot reverse
  // would be worse than no collapse.
  mainWin.setBounds({ ...mainWin.getBounds(), width: 1500 })
  await sleep(700)
  const restored = await readPanes()
  ok('widening the window brings the sidebar back', restored.sidebar !== null,
    JSON.stringify(restored))

  // Close-to-tray is on by default and *hides* the window, in which case it is
  // never destroyed and the state under test cannot arise — which is exactly why
  // this went unnoticed. Turning it off is a real setting, and also how the app
  // behaves on a desktop with no tray at all.
  const prefs = await import('../electron/services/preferences-service')
  prefs.patchAppState({ closeToTray: false })

  // Opened through the real channel, so it is the window the app really makes.
  await mainWin.webContents.executeJavaScript(`window.orbitMail.compose.open({})`, true)
  const opened = await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  ok('a compose window is open', opened)
  if (!opened) return
  const composeWin = BrowserWindow.getAllWindows().find((w) => w !== mainWin)!

  ok('the composer is a top-level window, not a child', composeWin.getParentWindow() === null,
    composeWin.getParentWindow() ? 'has a parent — the WM will treat it as a dialog' : '')

  // The assertion that actually failed before: ask the window manager, not
  // Electron. `isMaximizable()` returned true throughout — a transient window
  // simply had its maximize request ignored, leaving the bounds untouched.
  const beforeMax = composeWin.getBounds()
  composeWin.maximize()
  const maximized = await waitFor(() => composeWin.isMaximized(), 5000)
  const afterMax = composeWin.getBounds()
  ok('the composer can actually be maximized', maximized && afterMax.width > beforeMax.width,
    `${beforeMax.width}x${beforeMax.height} -> ${afterMax.width}x${afterMax.height}`)
  composeWin.unmaximize()
  await sleep(300)

  // ---------------------------------------------------------------------------
  // The size is remembered for the next composer. Closed with `close()`, not
  // `destroy()`: the size is recorded in the `close` handler, and destroy skips
  // it — which is also the honest limit of the feature, so it is worth the test
  // going the long way round rather than reaching for the shortcut.
  // ---------------------------------------------------------------------------
  composeWin.setSize(880, 560)
  await sleep(300)
  composeWin.close()
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)

  await mainWin.webContents.executeJavaScript(`window.orbitMail.compose.open({})`, true)
  await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  const second = BrowserWindow.getAllWindows().find((w) => w !== mainWin)!
  const reopenedAt = second.getBounds()
  ok('the next composer opens at the size the last one was left',
    reopenedAt.width === 880 && reopenedAt.height === 560,
    `${reopenedAt.width}x${reopenedAt.height}`)

  // Maximized is the state the setting exists for — someone who writes maximized
  // wants the next message maximized, and remembering only the pixel size would
  // reopen a screen-filling window that is not actually maximized.
  second.maximize()
  await waitFor(() => second.isMaximized(), 5000)
  second.close()
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)

  await mainWin.webContents.executeJavaScript(`window.orbitMail.compose.open({})`, true)
  await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  const third = BrowserWindow.getAllWindows().find((w) => w !== mainWin)!
  ok('and a maximized composer reopens maximized', await waitFor(() => third.isMaximized(), 5000))

  // Deliberately NOT asserted: what restoring that window down gives back. A
  // window maximized before it is mapped has no normal geometry for the WM to
  // restore to, so the first restore-down lands on a size Muffin invents. That
  // is a documented limitation rather than a check, because the obvious fix
  // makes it worse — see the comment in createComposeWindow. Pinning the
  // WM's invented number here would only pin Muffin's version of it.
  third.close()
  await waitFor(() => BrowserWindow.getAllWindows().length === 1)

  // Back to a composer for the lifecycle checks below.
  await mainWin.webContents.executeJavaScript(`window.orbitMail.compose.open({})`, true)
  await waitFor(() => BrowserWindow.getAllWindows().length > 1)
  const composeWin2 = BrowserWindow.getAllWindows().find((w) => w !== mainWin)!

  // Destroying every window would fire window-all-closed and quit the app before
  // anything could be asserted. This one belongs to the harness and takes no
  // part in what is being tested.
  const keepAlive = new BrowserWindow({ show: false })

  let composeClosed = false
  composeWin2.on('closed', () => { composeClosed = true })
  uncaught.length = 0

  // The user action: close the main window while a composer is open.
  mainWin.close()
  const gone = await waitFor(() => mainWin.isDestroyed())
  ok('the main window is really destroyed, not hidden to a tray', gone,
    gone ? '' : 'still alive — closeToTray took the close, so this proved nothing')
  if (!gone) return

  // The half-written message is the reason this is worth asserting rather than
  // simply allowing: closing the main window must not take unsaved text with it.
  await sleep(500)
  ok('the composer outlives the main window', !composeClosed && !composeWin2.isDestroyed())

  // Now close the composer with no main window left. Its `closed` handler runs
  // notifyMessagesUpdated() — badge, title and a send to the renderer — with
  // nothing to send to. Anything thrown is reported by the handler above, so
  // only the clean case is announced here. `destroy()` rather than `close()`
  // deliberately: it reaches `closed` without going through the save-as-draft
  // handler, which is the send suite's subject and would block on a prompt here.
  composeWin2.destroy()
  await waitFor(() => composeClosed)
  await sleep(500)
  if (uncaught.length === 0) {
    ok('closing both windows, main first, throws nothing', true, 'none')
  }

  keepAlive.destroy()
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    app.exit(failed === 0 ? 0 : 1)
  })
  .catch((err) => {
    console.error('\n[e2e:window] harness error:', err)
    app.exit(1)
  })
