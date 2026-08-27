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

const MODULES = [
  'attachment-safety',
  'network-reachability',
  'sync-policy',
  'thread-util'
]

const loaded = {}
const load = (name) => loaded[name]

async function main() {
  for (const name of MODULES) {
    const outfile = join(outDir, `${name}.cjs`)
    await build({
      entryPoints: [join(root, 'electron/services', `${name}.ts`)],
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
