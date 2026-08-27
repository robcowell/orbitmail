#!/usr/bin/env node
// Runner for the end-to-end checks that need **real windows**: starts GreenMail
// in Docker, builds each harness, and runs it in a windowed Electron process
// against the built renderer.
//
//   npm run test:e2e            build, run every suite, tear down
//   npm run test:e2e -- --keep  leave the container running afterwards
//
// The suites, each in its own Electron process:
//
// - `e2e-send.suite.ts` — the send path: draft, composer, real Send button,
//   GreenMail, Sent, no save-as-draft prompt. Needs the mail server.
// - `e2e-format.suite.ts` — the compose toolbar's font family and size, where
//   `document.execCommand` *is* the implementation and there is nothing
//   underneath it to unit-test. Ends by reopening the draft, because inline
//   styles have to survive DOMPurify on every load.
// - `e2e-zoom.suite.ts` — zoom, through real keystrokes: the pure helpers are
//   covered by test:imap, but whether the key reaches the handler and the frame
//   is actually zoomed needs a window to send a key to.
// - `e2e-undo.suite.ts` — undo, through a real click: whether pressing Undo on
//   the toast actually puts the mail back. The pure half is covered by
//   test:store and the lookup by test:imap; neither can render a toast, click
//   its button, or check the server afterwards. Needs the mail server.
// - `e2e-shortcuts.suite.ts` — the reader's keys, through real keystrokes:
//   pressing `a` opens a reply-all composer addressed to everyone on the thread
//   but us. Whether a key reaches the handler needs a window, and a reply-all
//   that quietly drops the other recipients looks like it worked.
// - `e2e-snooze.suite.ts` — snooze against a real server: the message leaves
//   INBOX, waits in Snoozed, and comes back when its action falls due. The
//   promise snooze makes is only observable from outside the app.
// - `e2e-window.suite.ts` — window lifecycle: closing the main window with a
//   composer open must not use the window after it is gone. Ends with every
//   window destroyed, which is why it cannot share a process with the above.
//
// Unlike `test:imap` these drive real BrowserWindows, which is the only way to
// reach a window's lifecycle — `close` handlers, the draft flush, parent/child
// destroy order. That also means:
//
// - **They need a display.** Headless Ozone segfaults as soon as a window is
//   created (hidden ones included), so there is no CI-friendly mode and this
//   script refuses to run without DISPLAY or WAYLAND_DISPLAY. `test:imap`
//   remains the suite that runs on every push.
// - **Windows appear on screen** for a few seconds, including compose windows.
// - Harness bundles are written into `out/main/` so that `__dirname` resolves
//   `../renderer` and `../preload` exactly as the real main bundle does. They are
//   deleted afterwards — a stray 6 MB file there would be packaged into the app.
import { spawn, spawnSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import {
  IMAGE, USER, dockerAvailable, startGreenMail, stopContainer, containerLogs, waitForImap
} from './greenmail.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONTAINER = 'orbit-mail-greenmail-e2e'
// Deliberately not test:imap's ports, so both can run at once and a container
// left behind by `test:imap -- --keep` does not collide with this one.
const PORTS = { imap: 3243, imaps: 4093, smtp: 3225 }

const SUITES = [
  { name: 'send', entry: 'e2e-send.suite.ts' },
  { name: 'signature', entry: 'e2e-signature.suite.ts' },
  { name: 'format', entry: 'e2e-format.suite.ts' },
  { name: 'window', entry: 'e2e-window.suite.ts' },
  { name: 'zoom', entry: 'e2e-zoom.suite.ts' },
  { name: 'undo', entry: 'e2e-undo.suite.ts' },
  { name: 'shortcuts', entry: 'e2e-shortcuts.suite.ts' },
  { name: 'snooze', entry: 'e2e-snooze.suite.ts' },
  { name: 'scheduled-send', entry: 'e2e-scheduled-send.suite.ts' },
  { name: 'reader-overflow', entry: 'e2e-reader-overflow.suite.ts' }
]

const keep = process.argv.includes('--keep')
// Run one suite by name: `npm run test:e2e -- --only window`. Ten suites take
// several minutes, which is a poor loop when chasing a single flaky one.
const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null

// Each suite gets its own app data, and the runner owns both: deleting a userData
// directory from inside a still-running app just leaves SQLite to recreate the
// WAL behind you.
const userDataDirs = []
function makeUserData() {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-e2e-'))
  userDataDirs.push(dir)
  return dir
}

const bundles = []
function bundlePath(name) {
  const path = join(ROOT, 'out', 'main', `e2e-${name}.cjs`)
  bundles.push(path)
  return path
}

function fail(message) {
  // Via cleanup, so bailing out early (no display, no Docker) still takes the
  // temp app-data directories with it.
  cleanup()
  console.error(`\n[test:e2e] ${message}`)
  process.exit(1)
}

function buildHarness(entry, bundle) {
  const res = spawnSync(join(ROOT, 'node_modules', '.bin', 'esbuild'), [
    join(ROOT, 'scripts', entry),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:electron',
    '--external:better-sqlite3',
    `--outfile=${bundle}`,
    '--log-level=warning'
  ], { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0) fail(`could not build ${entry}:\n${res.stdout}\n${res.stderr}`)
  if (res.stderr) process.stderr.write(res.stderr)
}

function runHarness(bundle, userData) {
  return new Promise((resolve) => {
    const electron = join(ROOT, 'node_modules', '.bin', 'electron')
    const child = spawn(electron, ['--no-sandbox', '--disable-gpu', bundle], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        // The dev shell sets this; with it set, Electron runs as plain Node and
        // `app` is undefined.
        ELECTRON_RUN_AS_NODE: '',
        ORBIT_TEST_USERDATA: userData,
        ORBIT_TEST_IMAP_PORT: String(PORTS.imap),
        ORBIT_TEST_SMTP_PORT: String(PORTS.smtp),
        ORBIT_TEST_EMAIL: USER.email,
        ORBIT_TEST_LOGIN: USER.login,
        ORBIT_TEST_PASSWORD: USER.password
      }
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  if (!keep) stopContainer(CONTAINER)
  for (const bundle of bundles) rmSync(bundle, { force: true })
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true })
}
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('SIGTERM', () => { cleanup(); process.exit(143) })

if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
  fail(
    'No display. These checks drive real windows, and headless Ozone segfaults on\n' +
    'the first BrowserWindow, so there is no headless mode. Use `npm run test:imap`\n' +
    'for the windowless suite (that is the one CI runs).'
  )
}
if (!dockerAvailable()) {
  fail('Docker is not available. The send suite needs it to run GreenMail.')
}

console.log(`[test:e2e] starting ${IMAGE} as ${CONTAINER}`)
const startError = startGreenMail({ container: CONTAINER, ports: PORTS })
if (startError) fail(`could not start GreenMail:\n${startError}`)
if (!(await waitForImap(PORTS.imap))) {
  fail('GreenMail did not accept IMAP connections in time')
}
console.log(`[test:e2e] GreenMail ready on imap:${PORTS.imap} smtp:${PORTS.smtp}`)
console.log('[test:e2e] windows will appear briefly — that is expected')

const failures = []
try {
  const selected = only ? SUITES.filter((s) => s.name === only) : SUITES
  if (only && selected.length === 0) {
    fail(`No suite called "${only}". Known: ${SUITES.map((s) => s.name).join(', ')}`)
  }
  for (const suite of selected) {
    console.log(`\n[test:e2e] ${suite.name}`)
    const bundle = bundlePath(suite.name)
    buildHarness(suite.entry, bundle)
    const code = await runHarness(bundle, makeUserData())
    if (code !== 0) failures.push(suite.name)
  }
  if (failures.length) {
    console.log('\n[test:e2e] GreenMail log (last 40 lines):')
    process.stdout.write(containerLogs(CONTAINER))
  }
} finally {
  cleanup()
  if (keep) console.log(`\n[test:e2e] container ${CONTAINER} left running (--keep)`)
}

console.log(
  failures.length
    ? `\n[test:e2e] failed: ${failures.join(', ')}`
    : `\n[test:e2e] all ${selected.length} suite${selected.length === 1 ? '' : 's'} passed`
)
process.exit(failures.length ? 1 : 0)
