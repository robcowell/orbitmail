#!/usr/bin/env node
// Pure main-process logic, under plain node.
//
//   npm run test:pure     # ~1s, no Docker, no Electron
//
// `test:imap` is the integration suite: it needs Docker for GreenMail and a
// windowless Electron process for the database. Several modules it covers need
// neither — they take values and return values, importing nothing. Those were
// tested there only because there was nowhere else to put them, which made them
// slow to run and impossible to mutation-test (a full `test:imap` sweep would
// take hours).
//
// They live here now. `test:imap` keeps the parts that genuinely need a server:
// that a refused connection reaches the *account* as "did not reach" is an
// integration fact, while what counts as refused is arithmetic.
//
// Every module bundled here must import nothing. The moment one needs the
// database or Electron it belongs back in `test:imap`, because this harness has
// neither and the failure would be a confusing module-resolution error rather
// than an honest one.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'orbit-pure-'))
const require = createRequire(import.meta.url)

let failures = 0
const ok = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)

// name -> path. Most live in electron/services; zoom.ts does not, and its only
// import is `import type` from electron, which esbuild erases — so it bundles to
// a file that requires nothing, same as the rest.
const MODULES = {
  'attachment-safety': 'electron/services/attachment-safety.ts',
  'connection-failure': 'electron/services/connection-failure.ts',
  'network-reachability': 'electron/services/network-reachability.ts',
  'sync-policy': 'electron/services/sync-policy.ts',
  'thread-util': 'electron/services/thread-util.ts',
  'window-geometry': 'electron/services/window-geometry.ts',
  zoom: 'electron/zoom.ts'
}

const loaded = {}
const load = (name) => loaded[name]

async function main() {
  for (const [name, path] of Object.entries(MODULES)) {
    const outfile = join(outDir, `${name}.cjs`)
    await build({
      entryPoints: [join(root, path)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      outfile,
      logLevel: 'silent'
    })
    loaded[name] = require(outfile)
  }

  // -------------------------------------------------------------------------
  section('Attachments: opening one must not silently run code')
  // -------------------------------------------------------------------------
  {
    const { isExecutableAttachment, attachmentExtension, executableAttachmentWarning } =
      load('attachment-safety')

    // The filename and its extension come from whoever sent the mail.
    const risky = [
      'invoice.pdf.exe', // reads as a PDF, ends in .exe
      'Statement.desktop', // a launcher on Linux
      'setup.sh',
      'installer.run',
      'tool.AppImage', // case must not matter
      'macro.vbs',
      'app.jar',
      'script.py'
    ]
    for (const name of risky) {
      ok(`warns before opening ${name}`, isExecutableAttachment(name))
    }

    const ordinary = [
      'invoice.pdf',
      'photo.jpeg',
      'notes.txt',
      'report.docx',
      'archive.zip',
      'sheet.xlsx',
      'exec-summary.pdf' // must not match on a substring
    ]
    for (const name of ordinary) {
      ok(`opens ${name} without a prompt`, !isExecutableAttachment(name))
    }

    ok('extension parsing takes the last segment',
      attachmentExtension('a.tar.gz') === 'gz' && attachmentExtension('README') === '')

    // The filename is the sender's, so it can be path-shaped, and the basename
    // split is what makes the *directory's* extension not count. Both cases below
    // fail without it: a plain lastIndexOf('.') reads "exe/readme" as an
    // extension, and reads "x/.sh" as .sh — which flips the warning on.
    ok('a directory carrying an extension does not lend it to the file',
      attachmentExtension('setup.exe/README') === '',
      attachmentExtension('setup.exe/README'))
    ok('a basename that is only a dot-extension is a dotfile, not an extension',
      !isExecutableAttachment('scripts/.sh') && attachmentExtension('scripts/.sh') === '')

    // Path-shaped and still risky — the separator handling has to work in the
    // ordinary direction too, for both kinds of slash.
    ok('a path-shaped filename is still classified by its basename',
      isExecutableAttachment('../../.local/share/applications/x.desktop') &&
        isExecutableAttachment('C:\\Users\\rob\\AppData\\setup.exe'))
    ok('and a risky-looking directory does not make an ordinary file risky',
      !isExecutableAttachment('invoice.exe/report.pdf'))

    // Neither of these is an extension, and treating them as one would either
    // nag on every dotfile or match the empty string against the set.
    ok('a leading dot is not an extension', attachmentExtension('.bashrc') === '')
    ok('a trailing dot is not an extension', attachmentExtension('setup.exe.') === '')
    // A name ending in a separator has an empty last segment, and an empty last
    // segment has no extension. Falling back to the whole filename instead would
    // report `sh/` — a shape nothing in the executable set matches, so the final
    // answer happens to survive while the extension it is derived from does not.
    ok('a name ending in a separator has no extension at all',
      attachmentExtension('malware.sh/') === '', attachmentExtension('malware.sh/'))

    // The warning is the whole mitigation — the dialog is what the user reads
    // before deciding, and a `.pdf.exe` is built so the eye stops at `.pdf`.
    const warning = executableAttachmentWarning('Invoice-2026.pdf.exe')
    ok('the warning names the file in full',
      warning.message.includes('Invoice-2026.pdf.exe'), warning.message)
    ok('and states the extension that actually decides what runs',
      warning.detail.includes('.exe') && !warning.detail.includes('.pdf file'),
      warning.detail.slice(0, 60))
    ok('the warning says opening may run a program, not that it will',
      /may run/.test(warning.detail))
    ok('and it names the sender as the reason to hesitate',
      /sender/.test(warning.detail))
  }

  // -------------------------------------------------------------------------
  section('Reachability: being refused is not being offline')
  // -------------------------------------------------------------------------
  {
    // The offline banner used to come from navigator.onLine, which reports
    // whether a network interface exists rather than whether anything is
    // reachable over it. This classifier is the evidence that replaced it, and
    // the distinction it has to get right is refused-vs-never-reached.
    const { isUnreachableError, reachedServer } = load('network-reachability')

    const code = (c) => Object.assign(new Error('boom'), { code: c })

    for (const c of ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN']) {
      ok(`${c} is a connection that never landed`, isUnreachableError(code(c)))
    }
    ok('the code is matched whatever its case', isUnreachableError(code('econnrefused')))

    // Several layers here rethrow as plain Errors, so the code is usually gone
    // by the time sync sees it — the message has to carry the classification.
    ok('a bare message still classifies',
      isUnreachableError(new Error('connect ECONNREFUSED 127.0.0.1:993')))
    ok('so does a DNS failure with no code',
      isUnreachableError(new Error('getaddrinfo ENOTFOUND imap.example.com')))
    ok('and a socket that hung up', isUnreachableError(new Error('socket hang up')))
    // The wording the libraries actually use. Matching only "socket timeout"
    // and "connection timeout" missed all of these, so a real outage was read
    // as "reached" and the banner never appeared.
    ok('a bare timeout counts', isUnreachableError(new Error('Command failed: Timeout')))
    ok('so does "timed out"', isUnreachableError(new Error('Timed out while connecting to server')))

    // The rule that matters most: being told "no" means we got there. Calling
    // this an outage sends the user to fix their wifi instead of their password.
    ok('an authentication failure is NOT unreachable',
      !isUnreachableError(new Error('Authentication failed: token expired')))
    ok('nor is an invalid_grant', !isUnreachableError(new Error('invalid_grant')))
    ok('nor a rejected password',
      !isUnreachableError(new Error('[AUTHENTICATIONFAILED] Invalid credentials')))
    // Auth errors that happen to name a host and a timeout-ish word must still
    // read as reached, which is why the auth test runs first.
    ok('an auth error mentioning a timeout is still not an outage',
      !isUnreachableError(new Error('Login timeout: authentication failed for imap.example.com')))

    ok('an unknown failure is treated as reached, not as an outage',
      !isUnreachableError(new Error('Something else went wrong')))
    ok('and so is a non-error value', !isUnreachableError(undefined))

    // What `catch (err)` can actually hand you. Every case here used an Error,
    // so the shape-extraction helpers were untested: a thrown string, a plain
    // object with a message, an object carrying only a code, and a number all
    // reach this classifier in the wild.
    ok('a thrown string is classified on its text',
      isUnreachableError('connect ECONNREFUSED 127.0.0.1:993') === true)
    ok('and a harmless thrown string is not',
      isUnreachableError('something else entirely') === false)
    ok('a plain object with a message is read like an Error',
      isUnreachableError({ message: 'getaddrinfo ENOTFOUND imap.example.com' }) === true)
    ok('an object carrying only a code is read on the code',
      isUnreachableError({ code: 'ENETUNREACH' }) === true)
    ok('a number is not an outage', isUnreachableError(42) === false)
    ok('nor is null', isUnreachableError(null) === false)
    ok('nor an object with neither code nor message', isUnreachableError({}) === false)

    // A code the list does not recognise must not be treated as unreachable
    // merely for existing — the check is membership, not presence.
    ok('an unrecognised code is not an outage',
      isUnreachableError(code('ESOMETHINGELSE')) === false)
    ok('an empty code falls through to the message',
      isUnreachableError(Object.assign(new Error('ECONNREFUSED here'), { code: '' })) === true)

    ok('reachedServer is the inverse of the classifier',
      reachedServer(new Error('invalid_grant')) === true &&
      reachedServer(code('ECONNREFUSED')) === false)

  }

  // -------------------------------------------------------------------------
  section('Sync window: zero days means everything, not nothing')
  // -------------------------------------------------------------------------
  {
    const { DEFAULT_SYNC_DAYS, getSyncCutoffTimestamp, isWithinSyncWindow, syncSinceDate } =
      load('sync-policy')

    ok('the default is 90 days', DEFAULT_SYNC_DAYS === 90, String(DEFAULT_SYNC_DAYS))

    // The sign convention decides whether a misconfigured account syncs all of
    // its mail or none of it, and those are opposite disasters.
    ok('zero days means no cutoff at all', getSyncCutoffTimestamp(0) === null)
    ok('and a negative number means the same', getSyncCutoffTimestamp(-30) === null)
    ok('a positive number gives a cutoff in the past',
      getSyncCutoffTimestamp(30) < Date.now())

    const day = 24 * 60 * 60 * 1000
    const cutoff = getSyncCutoffTimestamp(30)
    ok('the cutoff is the right distance back — 30 days, to the minute',
      Math.abs((Date.now() - cutoff) - 30 * day) < 60_000,
      `${Math.round((Date.now() - cutoff) / day)} days`)

    // With no cutoff, everything is in the window — including mail older than
    // any plausible limit. Inverting this would silently sync nothing.
    ok('with no cutoff even ancient mail is in the window',
      isWithinSyncWindow(0, 0) === true)
    ok('mail from today is in a 30-day window',
      isWithinSyncWindow(Date.now(), 30) === true)
    ok('mail from a year ago is not', isWithinSyncWindow(Date.now() - 365 * day, 30) === false)
    ok('mail from just inside the window is', isWithinSyncWindow(Date.now() - 29 * day, 30) === true)
    ok('and from just outside it is not',
      isWithinSyncWindow(Date.now() - 31 * day, 30) === false)
    // The boundary itself: exactly on the cutoff counts as inside, so a message
    // does not fall out of the window between two checks a millisecond apart.
    ok('a message exactly on the cutoff is inside the window',
      isWithinSyncWindow(getSyncCutoffTimestamp(30), 30) === true)

    ok('syncSinceDate is undefined when there is no cutoff',
      syncSinceDate(0) === undefined && syncSinceDate(-1) === undefined)
    ok('and a Date matching the cutoff otherwise',
      Math.abs(syncSinceDate(30).getTime() - getSyncCutoffTimestamp(30)) < 1000,
      String(syncSinceDate(30)))
  }

  // -------------------------------------------------------------------------
  section('Threading: one conversation, whatever the client did to the subject')
  // -------------------------------------------------------------------------
  {
    const { normalizeSubject, normalizeReferences, computeThreadId } = load('thread-util')

    ok('a plain subject normalizes to itself, lowercased',
      normalizeSubject('Q3 Launch Date') === 'q3 launch date')
    ok('a reply prefix is stripped', normalizeSubject('Re: Q3 launch') === 'q3 launch')
    ok('and repeated ones, however they are spelled',
      normalizeSubject('Re: Fwd: RE: Fw: Q3 launch') === 'q3 launch')
    ok('inner whitespace is collapsed so wrapping cannot split a thread',
      normalizeSubject('Re:   Q3    launch  ') === 'q3 launch')
    ok('a missing subject is the empty key, not a crash',
      normalizeSubject(null) === '' && normalizeSubject(undefined) === '')
    // "Rethink" begins with "re" — a prefix strip that is not anchored to the
    // colon eats real words and merges unrelated conversations.
    ok('a word that merely starts like a prefix is left alone',
      normalizeSubject('Rethinking the launch') === 'rethinking the launch')

    ok('references arrive as a string', normalizeReferences('<a@x> <b@x>') === '<a@x> <b@x>')
    ok('or as an array, which mailparser also hands back',
      normalizeReferences(['<a@x>', '<b@x>']) === '<a@x> <b@x>')
    ok('whitespace is normalized', normalizeReferences('  <a@x>\n  <b@x>  ') === '<a@x> <b@x>')
    ok('nothing at all is null, not an empty string',
      normalizeReferences(null) === null && normalizeReferences('') === null &&
      normalizeReferences('   ') === null && normalizeReferences([]) === null)

    // The precedence that groups a conversation: the References root is present
    // in every reply's chain and in both Inbox and Sent, so it wins over the
    // immediate parent and over the message's own id.
    ok('the first reference is the thread root',
      computeThreadId({ messageId: '<self@x>', inReplyTo: '<parent@x>',
        references: '<root@x> <parent@x>' }) === '<root@x>')
    ok('the immediate parent is used when there are no references',
      computeThreadId({ messageId: '<self@x>', inReplyTo: '<parent@x>' }) === '<parent@x>')
    ok('a message that starts a thread is its own root',
      computeThreadId({ messageId: '<self@x>' }) === '<self@x>')
    ok('and one with no headers at all falls back to its subject',
      computeThreadId({ subject: 'Re: Q3 launch' }) === 'subj:q3 launch')
    ok('two replies to the same subject with no headers group together',
      computeThreadId({ subject: 'Q3 launch' }) ===
      computeThreadId({ subject: 'Re: Q3 launch' }))
    ok('an empty references header does not beat a real in-reply-to',
      computeThreadId({ messageId: '<self@x>', inReplyTo: '<parent@x>', references: '   ' })
        === '<parent@x>')
    ok('an empty message id falls through to the subject rather than being used',
      computeThreadId({ messageId: '', subject: 'Q3 launch' }) === 'subj:q3 launch')
  }

  // -------------------------------------------------------------------------
  section('Zoom: the browser shortcuts, on the keys a layout actually produces')
  // -------------------------------------------------------------------------
  {
    // Electron's default menu already has Zoom In / Out / Actual Size, which is
    // why this looks free. It is not: those roles bind to the accelerators
    // `CommandOrControl+Plus` and `CommandOrControl+-`, and an accelerator
    // matches a key rather than the character a layout puts on it. Reported as
    // "CTRL- seems to be CTRL_ on my machine" — so the match is on the produced
    // character, every spelling of it.
    const zoom = load('zoom')
    const key = (k, over = {}) => ({
      type: 'keyDown', key: k, control: true, meta: false, alt: false, ...over
    })

    ok('Ctrl and the shifted plus zooms in', zoom.zoomActionForInput(key('+')) === 'in')
    ok('so does Ctrl and the unshifted key it lives on',
      zoom.zoomActionForInput(key('=')) === 'in')
    ok('and the numpad', zoom.zoomActionForInput(key('Add')) === 'in')
    ok('Ctrl and minus zooms out', zoom.zoomActionForInput(key('-')) === 'out')
    // The reported case: the shifted spelling of the same physical key.
    ok('and so does the underscore that some layouts send instead',
      zoom.zoomActionForInput(key('_')) === 'out')
    ok('and the numpad', zoom.zoomActionForInput(key('Subtract')) === 'out')
    ok('Ctrl and zero resets', zoom.zoomActionForInput(key('0')) === 'reset')
    // Numpad 0 with numlock off arrives as Insert, and it is in the switch.
    ok('and so does the numpad zero a numlock-off keyboard sends as Insert',
      zoom.zoomActionForInput(key('Insert')) === 'reset')

    ok('the same keys without Ctrl are just typing',
      zoom.zoomActionForInput(key('-', { control: false })) === null)
    ok('Cmd works too, for anyone on a Mac keyboard',
      zoom.zoomActionForInput(key('-', { control: false, meta: true })) === 'out')
    // Alt+Ctrl+- is somebody else's shortcut, not a sloppier spelling of this.
    ok('Alt makes it a different shortcut, not this one',
      zoom.zoomActionForInput(key('-', { alt: true })) === null)
    // Alt disqualifies even when it is Cmd rather than Ctrl held: the guard has
    // to be `(control || meta) && !alt`, and `&&` there is one token from `||`.
    ok('and Alt disqualifies a Cmd chord too',
      zoom.zoomActionForInput(key('-', { control: false, meta: true, alt: true })) === null)
    ok('while neither modifier at all is not a zoom either',
      zoom.zoomActionForInput(key('-', { control: false, meta: false })) === null)
    ok('key-up does not zoom a second time',
      zoom.zoomActionForInput(key('-', { type: 'keyUp' })) === null)
    ok('an unrelated key is ignored', zoom.zoomActionForInput(key('a')) === null)

    // Bounds exist so a mis-keyed shortcut cannot leave the app at a size the
    // user can no longer read well enough to undo it.
    let level = 0
    for (let i = 0; i < 50; i++) level = zoom.nextZoomLevel(level, 'in')
    ok('zooming in stops at a readable maximum', level === zoom.MAX_ZOOM_LEVEL, `${level}`)
    for (let i = 0; i < 100; i++) level = zoom.nextZoomLevel(level, 'out')
    ok('and out at a readable minimum', level === zoom.MIN_ZOOM_LEVEL, `${level}`)
    // One step from the middle, in each direction — the clamp must not be doing
    // the moving. `Math.min(MAX, Math.max(MIN, next))` with its bounds swapped
    // still passes both of the checks above.
    ok('a step in from the middle is one level up',
      zoom.nextZoomLevel(0, 'in') === 1, `${zoom.nextZoomLevel(0, 'in')}`)
    ok('and a step out is one level down',
      zoom.nextZoomLevel(0, 'out') === -1, `${zoom.nextZoomLevel(0, 'out')}`)
    ok('reset always lands on 100%',
      zoom.nextZoomLevel(level, 'reset') === 0 && zoom.zoomPercentage(0) === 100)
    ok('one step in is about 120%, as a browser would',
      zoom.zoomPercentage(1) === 120, `${zoom.zoomPercentage(1)}%`)
    // Rounded, not truncated — and the level has to be one where those differ.
    // 1.2^-1 is 83.33%, which both round and trunc call 83, so an assertion
    // there proves nothing; the mutation check said so. The two bounds do
    // differ, and they are the percentages the file's own comment promises.
    ok('the bounds are the ~58% to ~300% the comment claims',
      zoom.zoomPercentage(zoom.MIN_ZOOM_LEVEL) === 58 &&
        zoom.zoomPercentage(zoom.MAX_ZOOM_LEVEL) === 299,
      `${zoom.zoomPercentage(zoom.MIN_ZOOM_LEVEL)}% to ${zoom.zoomPercentage(zoom.MAX_ZOOM_LEVEL)}%`)

    // A corrupted or hand-edited preferences blob must not be able to open the
    // app at a size it cannot be fixed from.
    ok('a stored level is clamped on the way back in',
      zoom.sanitizeZoomLevel(99) === zoom.MAX_ZOOM_LEVEL &&
        zoom.sanitizeZoomLevel(-99) === zoom.MIN_ZOOM_LEVEL)
    // A level already inside the bounds must survive untouched — a sanitizer
    // that clamped everything to one end would pass the two checks above.
    ok('and one already in range is returned as it was',
      zoom.sanitizeZoomLevel(2) === 2 && zoom.sanitizeZoomLevel(-2) === -2)
    ok('and nonsense resolves to 100%',
      zoom.sanitizeZoomLevel(undefined) === 0 && zoom.sanitizeZoomLevel(Number.NaN) === 0 &&
        zoom.sanitizeZoomLevel('big') === 0)
    // Infinity is a number and passes a bare typeof check, so the finite test is
    // load-bearing: without it a stored Infinity would clamp to MAX rather than
    // fall back, which is a different answer.
    ok('and an infinite level falls back rather than clamping',
      zoom.sanitizeZoomLevel(Number.POSITIVE_INFINITY) === 0)
  }

  // -------------------------------------------------------------------------
  section('Compose window size: a remembered one, validated against this screen')
  // -------------------------------------------------------------------------
  {
    const { resolveComposeSize } = load('window-geometry')
    const screen = { width: 1920, height: 1080 }

    const fallback = resolveComposeSize(undefined, screen)
    ok('nothing remembered opens at the size the composer always had',
      fallback.width === 640 && fallback.height === 720, JSON.stringify(fallback))

    const remembered = resolveComposeSize({ width: 900, height: 800 }, screen)
    ok('a remembered size is used as given',
      remembered.width === 900 && remembered.height === 800, JSON.stringify(remembered))

    // The stored value outlives the display that produced it. Sized on a 4K
    // monitor, reopened on a laptop: without this the composer opens wider than
    // the screen with its Send button past the edge.
    const huge = resolveComposeSize({ width: 3800, height: 2000 }, screen)
    ok('a size larger than the screen is brought back to it',
      huge.width === 1920 && huge.height === 1080, JSON.stringify(huge))

    // Below the window's own minWidth/minHeight the composer is unusable, and a
    // preferences blob is a file a user can edit.
    const tiny = resolveComposeSize({ width: 10, height: 10 }, screen)
    ok('and one below the minimum is brought up to it',
      tiny.width === 480 && tiny.height === 400, JSON.stringify(tiny))

    // Exactly at each bound. A `>=` that should be `>` changes nothing in the
    // middle of the range and everything here.
    const atMin = resolveComposeSize({ width: 480, height: 400 }, screen)
    ok('a size exactly at the minimum is left alone',
      atMin.width === 480 && atMin.height === 400, JSON.stringify(atMin))
    const atScreen = resolveComposeSize({ width: 1920, height: 1080 }, screen)
    ok('and one exactly filling the screen is too',
      atScreen.width === 1920 && atScreen.height === 1080, JSON.stringify(atScreen))

    // A corrupted blob arrives as the wrong type, not as a small number. NaN
    // fails every comparison, so a bare Math.max/min would pass it straight
    // through to a window with NaN for a width.
    const junk = resolveComposeSize({ width: NaN, height: 'tall' }, screen)
    ok('garbage falls back rather than reaching the window',
      junk.width === 640 && junk.height === 720, JSON.stringify(junk))
    // Infinity is a number, and `Math.min(Infinity, screen)` would quietly give
    // a full-screen composer rather than the default one.
    const infinite = resolveComposeSize({ width: Infinity, height: Infinity }, screen)
    ok('and so does an infinite one',
      infinite.width === 640 && infinite.height === 720, JSON.stringify(infinite))

    // A fractional size reaches BrowserWindow as-is otherwise, and a window
    // cannot be 640.5px wide.
    const fractional = resolveComposeSize({ width: 900.6, height: 800.4 }, screen)
    ok('a fractional stored size is rounded to whole pixels',
      fractional.width === 901 && fractional.height === 800, JSON.stringify(fractional))

    // The pathological display: a work area narrower than the composer's own
    // minimum. The minimum has to win, because a window below its minWidth is
    // one the user cannot use at all — so the max bound is itself floored at
    // the min, and `Math.max(min, max)` there is one token from `Math.min`.
    const cramped = resolveComposeSize({ width: 900, height: 800 }, { width: 300, height: 200 })
    ok('a screen smaller than the minimum still gives a usable window',
      cramped.width === 480 && cramped.height === 400, JSON.stringify(cramped))
    // And with nothing remembered, the same screen must not drag the default
    // below the minimum either.
    const crampedDefault = resolveComposeSize(undefined, { width: 300, height: 200 })
    ok('and so does that screen with nothing remembered',
      crampedDefault.width === 640 && crampedDefault.height === 720,
      JSON.stringify(crampedDefault))
  }

  // -------------------------------------------------------------------------
  section('Connection failures: the reason, not "Command failed"')
  // -------------------------------------------------------------------------
  {
    const { classifyConnectionFailure, describeConnectionFailure, describeAccountSyncFailure } =
      load('connection-failure')

    // The shape ImapFlow actually produces for a rejected LOGIN, captured from
    // a real server. `message` is the useless part; `response` is the answer.
    const imapAuth = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      response: '3 NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)'
    })
    ok('a rejected IMAP login is classified from the response, not the message',
      classifyConnectionFailure(imapAuth).kind === 'auth' && imapAuth.message === 'Command failed',
      classifyConnectionFailure(imapAuth).kind)
    ok('the IMAP command tag is stripped as the bookkeeping it is',
      classifyConnectionFailure(imapAuth).response === '[AUTHENTICATIONFAILED] Invalid credentials (Failure)',
      classifyConnectionFailure(imapAuth).response)

    const kind = (err) => classifyConnectionFailure(err).kind
    const withCode = (code, message = 'x') => Object.assign(new Error(message), { code })
    ok('a certificate that does not cover the host is its own kind',
      kind(withCode('ERR_TLS_CERT_ALTNAME_INVALID')) === 'certificate')
    ok('and is recognised from the message when no code is set',
      kind(new Error("Hostname/IP does not match certificate's altnames: ...")) === 'certificate')
    ok('a missing hostname is dns', kind(withCode('ENOTFOUND')) === 'dns')
    ok('a temporary resolver failure is dns too', kind(withCode('EAI_AGAIN')) === 'dns')
    ok('a refused connection is refused', kind(withCode('ECONNREFUSED')) === 'refused')
    ok('a timeout is a timeout', kind(withCode('ETIMEDOUT')) === 'timeout')
    ok("nodemailer's EAUTH is an auth failure", kind(withCode('EAUTH')) === 'auth')
    ok('an SMTP 535 is an auth failure',
      kind(Object.assign(new Error('Invalid login: 535 Bad'), { response: '535 Bad' })) === 'auth')
    ok('anything else stays unknown', kind(new Error('something odd')) === 'unknown')

    // A whitespace-only `response` is not an answer. Without the length filter
    // it would win over a `responseText` that actually says something, and the
    // user would be told the server said nothing at all.
    ok('a blank response does not beat a real one',
      classifyConnectionFailure(
        Object.assign(new Error('x'), { response: '   ', responseText: '535 Bad credentials' })
      ).response === '535 Bad credentials',
      classifyConnectionFailure(
        Object.assign(new Error('x'), { response: '   ', responseText: '535 Bad credentials' })
      ).response)

    // A thrown value that is falsy but not nullish is still *something* that was
    // thrown, and losing it leaves an empty message on screen. `??` keeps it;
    // `||` would discard it, which is the difference this pins.
    ok('a falsy non-nullish thrown value is kept, not discarded',
      classifyConnectionFailure(0).message === '0',
      JSON.stringify(classifyConnectionFailure(0).message))
    ok('while a nullish one yields an empty message',
      classifyConnectionFailure(null).message === '' &&
        classifyConnectionFailure(undefined).message === '')
    // The status word is stripped case-sensitively, so an ordinary sentence
    // beginning "No ..." is not served to the user with its first word missing.
    ok('a human sentence starting "No" keeps its first word',
      classifyConnectionFailure(
        Object.assign(new Error('x'), { response: '2 NO No such mailbox' })
      ).response === 'No such mailbox',
      classifyConnectionFailure(
        Object.assign(new Error('x'), { response: '2 NO No such mailbox' })
      ).response)
    ok('a non-error value does not throw', kind(null) === 'unknown')

    // --- Dialog wording: names which of the two servers refused. -----------
    const dlg = (err, stage, host) => describeConnectionFailure(err, stage, host).message
    const auth = dlg(imapAuth, 'Incoming', 'mail.example.eu')
    ok('the dialog names the server that refused',
      auth.includes('Incoming server (mail.example.eu)'), auth)
    ok('and quotes what that server actually said',
      auth.includes('[AUTHENTICATIONFAILED] Invalid credentials'), auth)
    const cert = dlg(withCode('ERR_TLS_CERT_ALTNAME_INVALID'), 'Outgoing', 'smtp.example.org')
    ok('a certificate failure names the outgoing server only',
      cert.includes('Outgoing server (smtp.example.org)') && !cert.includes('Incoming'), cert)
    ok('and says to use the provider\'s own server name',
      /rather than one under your own domain/.test(cert), cert)
    const unknownDlg = dlg(new Error('something odd'), 'Incoming', 'h')
    ok('an unrecognised failure still names the server and keeps the detail',
      unknownDlg.includes('Incoming server (h)') && unknownDlg.includes('something odd'),
      unknownDlg)

    // --- Status-bar wording: reason only, because the display adds the address.
    const sync = (err) => describeAccountSyncFailure(err)
    const syncAuth = sync(imapAuth)
    ok('the sync reason never repeats the address (syncStatus.ts renders it)',
      !syncAuth.includes('@'), syncAuth)
    ok('a rejected login points at the password and where to change it',
      /rejected the login/.test(syncAuth) && /Settings/.test(syncAuth), syncAuth)
    ok('a certificate problem is not reported as a password problem',
      /certificate/.test(sync(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))) &&
        !/password/.test(sync(withCode('ERR_TLS_CERT_ALTNAME_INVALID'))),
      sync(withCode('ERR_TLS_CERT_ALTNAME_INVALID')))
    ok('a hostname typo is reported as one',
      /could not be found/.test(sync(withCode('ENOTFOUND'))), sync(withCode('ENOTFOUND')))

    // The friendly errors written elsewhere must survive untouched — this is
    // what stops the classifier flattening formatGmailAuthError's guidance.
    const friendly = new Error('Gmail sign-in failed for a@b. Check that: ...')
    ok('an already-friendly message is passed through unchanged',
      sync(friendly) === friendly.message, sync(friendly))

    // Every one of these is rendered in a toast or a one-line status bar.
    for (const m of [auth, cert, unknownDlg, syncAuth, sync(withCode('ENOTFOUND'))]) {
      ok('the message is a single line', !m.includes('\n'), JSON.stringify(m))
    }
  }

  console.log(
    `\n${failures === 0 ? 'all pure-logic checks passed' : `${failures} pure-logic check(s) FAILED`}`
  )
  return failures === 0 ? 0 : 1
}

main()
  .then((code) => {
    rmSync(outDir, { recursive: true, force: true })
    process.exit(code)
  })
  .catch((err) => {
    console.error(err)
    rmSync(outDir, { recursive: true, force: true })
    process.exit(1)
  })
