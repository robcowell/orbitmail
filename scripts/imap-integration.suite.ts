// Integration suite — runs inside a windowless Electron main process started by
// scripts/imap-integration.mjs, against a real GreenMail server.
//
// It imports the app's own services (no reimplementation) and points the DB at
// a throwaway userData directory, so the SQLite schema, sync, and IDLE code
// paths are the ones that ship.
//
// GreenMail's plain IMAP port does not advertise STARTTLS, which makes it an
// accurate stand-in for the downgrade case the TLS check cares about.
import { app } from 'electron'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { ImapFlow } from 'imapflow'

const CONTAINER = process.env.ORBIT_TEST_CONTAINER ?? 'orbit-mail-greenmail-test'
const IMAP_PORT = Number(process.env.ORBIT_TEST_IMAP_PORT ?? 3143)
const SMTP_PORT = Number(process.env.ORBIT_TEST_SMTP_PORT ?? 3025)
const EMAIL = process.env.ORBIT_TEST_EMAIL ?? 'rob@example.com'
const LOGIN = process.env.ORBIT_TEST_LOGIN ?? 'rob'
const PASSWORD = process.env.ORBIT_TEST_PASSWORD ?? 'secret'
const HOST = '127.0.0.1'

// ---------------------------------------------------------------------------
// Tiny harness. `todo` records a check that documents a known-open bug: it is
// reported but does not fail the run.
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
let todos = 0

function ok(label: string, condition: boolean, detail = ''): void {
  const suffix = detail ? ` — ${detail}` : ''
  if (condition) {
    passed++
    console.log(`  ok    ${label}${suffix}`)
  } else {
    failed++
    console.log(`  FAIL  ${label}${suffix}`)
  }
}

function todo(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++
    console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
    return
  }
  todos++
  console.log(`  todo  ${label}${detail ? ` — ${detail}` : ''}`)
}

function section(name: string): void {
  console.log(`\n${name}`)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rejects(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn()
    return null
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}

// ---------------------------------------------------------------------------
// GreenMail helpers
// ---------------------------------------------------------------------------

function rawClient(): ImapFlow {
  return new ImapFlow({
    host: HOST,
    port: IMAP_PORT,
    secure: false,
    auth: { user: LOGIN, pass: PASSWORD },
    logger: false
  })
}

function messageSource(subject: string, n: number): Buffer {
  return Buffer.from(
    [
      `From: Sender ${n} <sender${n}@example.com>`,
      `To: Me <${EMAIL}>`,
      `Subject: ${subject}`,
      `Message-ID: <integration-${subject.replace(/\W+/g, '-')}-${n}@example.com>`,
      `Date: ${new Date(Date.now() - n * 60_000).toUTCString()}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      `Body of ${subject} #${n}`,
      ''
    ].join('\r\n')
  )
}

async function seed(client: ImapFlow, mailbox: string, subjects: string[]): Promise<void> {
  for (const [i, subject] of subjects.entries()) {
    await client.append(mailbox, messageSource(subject, i + 1), ['\\Seen'])
  }
}

function restartGreenMail(): void {
  execFileSync('docker', ['restart', CONTAINER], { stdio: 'ignore' })
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const userData = mkdtempSync(join(tmpdir(), 'orbit-mail-itest-'))
  app.setPath('userData', userData)

  // Imported after userData is redirected: the DB opens lazily, but keep the
  // ordering obvious rather than relying on it.
  const { imapConnectionSecurity } = await import('../electron/services/account-credentials')
  const db = await import('../electron/services/db-service')
  const sync = await import('../electron/services/imap-sync')
  const idle = await import('../electron/services/imap-idle')

  const account = db.saveManualAccount('imap', {
    authType: 'password',
    email: EMAIL,
    displayName: 'Integration',
    username: LOGIN,
    password: PASSWORD,
    incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
    outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
  })

  // -------------------------------------------------------------------------
  section('Docs: claims must match the code (CLAUDE.md rule 6)')
  // -------------------------------------------------------------------------
  {
    // Rule 6 says docs ship with the change. It was written because they did
    // not: README and DEVELOPERS.md both described credentials as "baked in at
    // build time" after that became prohibited, and the FTS index stayed
    // documented in four places for hours after being deleted.
    //
    // This cannot check prose. It checks the claims that are mechanically
    // verifiable — the ones that go stale silently.
    const { existsSync, readFileSync } = await import('fs')
    const docs = ['README.md', 'DEVELOPERS.md', 'CLAUDE.md'].filter((f) =>
      existsSync(join(process.cwd(), f))
    )
    const text = docs.map((f) => readFileSync(join(process.cwd(), f), 'utf8')).join('\n')
    const inlineCode = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim())

    // 1. Every `npm run x` the docs mention actually exists.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
    const cited = [...new Set(
      inlineCode.filter((v) => /^npm run [a-z][\w:-]*$/.test(v)).map((v) => v.replace('npm run ', ''))
    )]
    const missingScripts = cited.filter((name) => !pkg.scripts?.[name])
    ok('every documented npm script exists', missingScripts.length === 0,
      missingScripts.length ? `missing: ${missingScripts.join(', ')}` : `${cited.length} scripts`)

    // 2. Every source path the docs point at still exists. Build output is
    //    skipped: it is absent until `npm run build`, which is not this suite's
    //    job to require.
    const citedPaths = [...new Set(
      inlineCode.filter(
        (v) =>
          /^[\w.@/-]+\.(ts|tsx|js|mjs|cjs|json|yml|md|css|html)$/.test(v) &&
          v.includes('/') &&
          !v.startsWith('out/') &&
          !v.startsWith('release/')
      )
    )]
    const missingPaths = citedPaths.filter((rel) => !existsSync(join(process.cwd(), rel)))
    ok('every documented file path exists', missingPaths.length === 0,
      missingPaths.length ? `missing: ${missingPaths.join(', ')}` : `${citedPaths.length} paths`)

    // 3. The Electron major version the docs claim matches package.json.
    const claimed = /Electron (\d+)/.exec(text)?.[1]
    const actual = /(\d+)/.exec(pkg.devDependencies?.electron ?? '')?.[1]
    ok('the documented Electron version matches package.json',
      !claimed || !actual || claimed === actual, `docs=${claimed} package.json=${actual}`)

    // 4. Rule 5's counterpart in prose: no document may describe credentials as
    //    compiled into a build, because that is the behaviour rule 5 forbids.
    const forbidden = [
      /credentials[^.\n]{0,40}(baked|embedded|inlined)[^.\n]{0,30}build/i,
      /(baked|embedded)[^.\n]{0,20}in at build time/i,
      /OAuth[^.\n]{0,30}embedded at build time/i
    ]
    const offenders = docs.filter((f) => {
      const body = readFileSync(join(process.cwd(), f), 'utf8')
      return forbidden.some((re) => re.test(body))
    })
    ok('no document claims credentials are built into a package',
      offenders.length === 0, offenders.join(', ') || `${docs.length} docs checked`)
  }

  // -------------------------------------------------------------------------
  section('IPC contract: every channel the renderer invokes has a handler')
  // -------------------------------------------------------------------------
  {
    // preload.ts and main.ts must stay in lockstep — CLAUDE.md calls this the
    // spine. Nothing checked it, and an oauth: handler was once added to the
    // preload but silently not to main: the renderer got "No handler registered
    // for 'oauth:getStatus'" at runtime, with a clean build and a green suite.
    const { readFileSync } = await import('fs')
    const preload = readFileSync(join(process.cwd(), 'electron', 'preload.ts'), 'utf8')
    const mainSource = readFileSync(join(process.cwd(), 'electron', 'main.ts'), 'utf8')

    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(\s*'([^']+)'/g)].map((m) => m[1])
    const handled = new Set(
      [...mainSource.matchAll(/ipcMain\.handle\(\s*\n?\s*'([^']+)'/g)].map((m) => m[1])
    )
    const orphans = [...new Set(invoked)].filter((channel) => !handled.has(channel))

    ok('preload declares invoke channels', invoked.length > 20, `${invoked.length} channels`)
    ok('every invoked channel has a main-process handler', orphans.length === 0,
      orphans.length ? `missing: ${orphans.join(', ')}` : `${handled.size} handlers`)
  }

  // -------------------------------------------------------------------------
  section('OAuth config: credentials must never be built into the app')
  // -------------------------------------------------------------------------
  {
    // A packaged app is started from a desktop entry, so dotenv's cwd lookup
    // finds nothing and .env is not in electron-builder's `files`. Credentials
    // therefore come from the environment, ~/.config/orbit-mail/.env, or values
    // baked in at build time — in that order.
    const cfg = await import('../electron/services/oauth-config')
    const saved = {
      gid: process.env.GOOGLE_CLIENT_ID,
      gsecret: process.env.GOOGLE_CLIENT_SECRET,
      mid: process.env.MICROSOFT_CLIENT_ID,
      tenant: process.env.MICROSOFT_TENANT_ID
    }
    try {
      process.env.GOOGLE_CLIENT_ID = 'runtime-id'
      process.env.GOOGLE_CLIENT_SECRET = 'runtime-secret'
      const google = cfg.getGoogleOAuthConfig()
      ok('credentials are read from the environment at runtime',
        google.clientId === 'runtime-id' && google.clientSecret === 'runtime-secret')

      process.env.MICROSOFT_CLIENT_ID = 'ms-id'
      delete process.env.MICROSOFT_TENANT_ID
      ok('microsoft tenant defaults to common',
        cfg.getMicrosoftOAuthConfig().tenantId === 'common')

      // This suite is bundled without the app's define block, so with the
      // environment cleared there is nothing left to fall back to.
      delete process.env.GOOGLE_CLIENT_ID
      delete process.env.GOOGLE_CLIENT_SECRET
      let err: Error | null = null
      try {
        cfg.getGoogleOAuthConfig()
      } catch (e) {
        err = e as Error
      }
      ok('missing credentials throw rather than half-configure', err !== null)
      ok('the error names every place they can be supplied',
        !!err && err.message.includes('~/.config/orbit-mail/.env') && err.message.includes('.env'),
        err?.message.split('\n')[0])
      ok('hasGoogleOAuthConfig reports absence without throwing',
        cfg.hasGoogleOAuthConfig() === false)
    } finally {
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      restore('GOOGLE_CLIENT_ID', saved.gid)
      restore('GOOGLE_CLIENT_SECRET', saved.gsecret)
      restore('MICROSOFT_CLIENT_ID', saved.mid)
      restore('MICROSOFT_TENANT_ID', saved.tenant)
    }

    // Credentials entered in the app: stored encrypted, below the environment,
    // and never readable by the renderer.
    {
      const store = await import('../electron/services/oauth-config')
      const savedEnv = {
        id: process.env.MICROSOFT_CLIENT_ID,
        tenant: process.env.MICROSOFT_TENANT_ID
      }
      try {
        delete process.env.MICROSOFT_CLIENT_ID
        delete process.env.MICROSOFT_TENANT_ID

        ok('a provider with nothing configured reports unconfigured',
          store.getOAuthConfigStatus().microsoft === false)

        store.setStoredOAuthCredentials({ MICROSOFT_CLIENT_ID: 'stored-ms-id' })
        ok('credentials entered in the app make the provider usable',
          store.getOAuthConfigStatus().microsoft === true)
        ok('and are what the flow then uses',
          store.getMicrosoftOAuthConfig().clientId === 'stored-ms-id')

        // The environment must win, or the app would silently disagree with a
        // .env the user just edited.
        process.env.MICROSOFT_CLIENT_ID = 'env-ms-id'
        ok('the environment still overrides a stored value',
          store.getMicrosoftOAuthConfig().clientId === 'env-ms-id')
        ok('status reports which keys came from the environment',
          store.getOAuthConfigStatus().fromEnvironment.includes('MICROSOFT_CLIENT_ID'))
        delete process.env.MICROSOFT_CLIENT_ID

        // Status is the only thing the renderer receives.
        const status = store.getOAuthConfigStatus()
        const serialised = JSON.stringify(status)
        ok('status never carries credential values back to the renderer',
          !serialised.includes('stored-ms-id'), serialised.slice(0, 80))

        store.setStoredOAuthCredentials({ MICROSOFT_CLIENT_ID: '' })
        ok('an empty value clears the stored credential',
          store.getOAuthConfigStatus().microsoft === false)
      } finally {
        store.setStoredOAuthCredentials({ MICROSOFT_CLIENT_ID: '' })
        if (savedEnv.id === undefined) delete process.env.MICROSOFT_CLIENT_ID
        else process.env.MICROSOFT_CLIENT_ID = savedEnv.id
        if (savedEnv.tenant === undefined) delete process.env.MICROSOFT_TENANT_ID
        else process.env.MICROSOFT_TENANT_ID = savedEnv.tenant
      }
    }

    // A build must never contain credentials: a package has to be safe to hand
    // to someone else. This is the guard on that promise.
    const { existsSync, readFileSync } = await import('fs')
    const bundle = join(process.cwd(), 'out', 'main', 'index.js')
    const configSource = join(process.cwd(), 'electron.vite.config.ts')

    if (existsSync(configSource)) {
      const config = readFileSync(configSource, 'utf8')
      ok('the build config defines no OAuth constants',
        !/__OAUTH_|GOOGLE_CLIENT|MICROSOFT_CLIENT/.test(config))
    }

    if (!existsSync(bundle)) {
      todo('build output present to scan for credentials', false, 'run npm run build first')
    } else {
      const source = readFileSync(bundle, 'utf8')
      ok('no OAuth placeholders survive in the bundle',
        !source.includes('__OAUTH_'))

      // Read the project .env directly rather than the environment: this suite
      // does not load it, and a developer machine is exactly where a leak would
      // show up. CI has no .env, so there it degrades to the checks above.
      const envPath = join(process.cwd(), '.env')
      const values = existsSync(envPath)
        ? readFileSync(envPath, 'utf8')
            .split('\n')
            .map((line) => /^\s*(GOOGLE_CLIENT_ID|GOOGLE_CLIENT_SECRET|MICROSOFT_CLIENT_ID)\s*=\s*(.+)$/.exec(line))
            .filter((m): m is RegExpExecArray => !!m)
            .map((m) => ({ key: m[1], value: m[2].trim().replace(/^["']|["']$/g, '') }))
            .filter((entry) => entry.value.length > 8)
        : []
      const leaked = values.filter((entry) => source.includes(entry.value))
      ok('no real credential value appears in the build output',
        leaked.length === 0,
        leaked.length
          ? `LEAKED: ${leaked.map((l) => l.key).join(', ')}`
          : values.length
            ? `checked ${values.length} value(s) from .env`
            : 'no .env present to check against')
    }
  }

  // -------------------------------------------------------------------------
  section('Attachments: opening one must not silently run code')
  // -------------------------------------------------------------------------
  {
    const { isExecutableAttachment, attachmentExtension } = await import(
      '../electron/services/attachment-safety'
    )

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
  }

  // -------------------------------------------------------------------------
  section('Launcher badge: the Unity signal must be well-formed')
  // -------------------------------------------------------------------------
  {
    // The badge is emitted with gdbus, whose failures were swallowed as "this
    // desktop ignores Unity signals". A malformed object path fails the same
    // way, so a permanently broken badge looked like an environment quirk for
    // as long as it existed. These are pure string checks — no D-Bus needed.
    const { unityObjectPath, unityBadgeProperties } = await import('../electron/app-badge')
    const { LINUX_DESKTOP_ENTRY_ID } = await import('../electron/app-icon')

    // D-Bus allows only [A-Za-z0-9_] between slashes.
    const VALID_OBJECT_PATH = /^(\/[A-Za-z0-9_]+)+$/
    const path = unityObjectPath()
    ok('object path is a valid D-Bus path', VALID_OBJECT_PATH.test(path), path)
    ok('object path is stable across calls', unityObjectPath() === path)

    // The old form, kept here so the specific regression stays described.
    const percentEncoded = `/com/canonical/Unity/LauncherEntry/${encodeURIComponent(
      `application://${LINUX_DESKTOP_ENTRY_ID}`
    )}`
    ok('a percent-encoded app URI would be rejected as a path',
      !VALID_OBJECT_PATH.test(percentEncoded))

    const set = unityBadgeProperties(3)
    const clear = unityBadgeProperties(0)
    ok('a non-zero count shows the badge', set.includes("'count-visible': <true>"), set)
    ok('zero hides the badge', clear.includes("'count-visible': <false>"), clear)
    ok('count is typed int64, as the LauncherEntry spec expects',
      set.includes('<int64 3>') && clear.includes('<int64 0>'))

    // Electron's Linux badge/progress APIs want the *.desktop file name.
    ok('desktop entry id keeps its .desktop suffix',
      LINUX_DESKTOP_ENTRY_ID.endsWith('.desktop'), LINUX_DESKTOP_ENTRY_ID)
  }

  // -------------------------------------------------------------------------
  section('OAuth: the loopback listener accepts only our own callback')
  // -------------------------------------------------------------------------
  {
    // The listener is reachable by anything that can talk to localhost, which
    // includes any web page the user has open. Without a state check, such a
    // page could deliver its own authorization code and the app would exchange
    // it, binding the attacker's mailbox to this client.
    const { startLoopbackServer, generateState } = await import(
      '../electron/services/oauth-loopback'
    )
    const status = async (port: number, qs: string) =>
      (await fetch(`http://127.0.0.1:${port}/callback${qs}`)).status

    const state = generateState()
    const srv = await startLoopbackServer({ expectedState: state })
    let resolved: string | null = null
    void srv.waitForCode().then((c) => {
      resolved = c
    })

    const wrong = await status(srv.port, '?code=ATTACKER_CODE&state=wrong')
    const missing = await status(srv.port, '?code=ATTACKER_CODE')
    await sleep(100)
    ok('callback with a wrong state is rejected', wrong === 400, `HTTP ${wrong}`)
    ok('callback with no state is rejected', missing === 400, `HTTP ${missing}`)
    ok('an injected code never completes the flow', resolved === null, String(resolved))

    // A hostile page must not be able to abort a real sign-in by racing it.
    const real = await status(srv.port, `?code=REAL_CODE&state=${encodeURIComponent(state)}`)
    await sleep(100)
    ok('the genuine callback still succeeds afterwards',
      real === 200 && resolved === 'REAL_CODE', `HTTP ${real} code=${resolved}`)
    srv.close()

    ok('state is high-entropy and per-attempt',
      generateState() !== generateState() && generateState().length >= 40)

    // An abandoned sign-in must not leave the port bound for the app's lifetime.
    const abandoned = await startLoopbackServer({ expectedState: generateState(), timeoutMs: 300 })
    const err = await abandoned.waitForCode().then(() => null, (e: Error) => e)
    ok('an abandoned sign-in times out', !!err && /timed out/i.test(err.message), err?.message)
    let stillUp = true
    try {
      await fetch(`http://127.0.0.1:${abandoned.port}/callback`)
    } catch {
      stillUp = false
    }
    ok('the listener is closed after timing out', !stillUp)
  }

  // -------------------------------------------------------------------------
  section('TLS: STARTTLS must be required, not opportunistic')
  // -------------------------------------------------------------------------
  {
    const caps = imapConnectionSecurity('starttls')
    ok('starttls maps to a mandatory upgrade', caps.secure === false && caps.doSTARTTLS === true,
      JSON.stringify(caps))

    // GreenMail's plain port offers no STARTTLS, so this is the downgrade case.
    const err = await rejects(async () => {
      const client = new ImapFlow({
        host: HOST,
        port: IMAP_PORT,
        ...imapConnectionSecurity('starttls'),
        auth: { user: LOGIN, pass: PASSWORD },
        logger: false
      })
      await client.connect()
      await client.logout()
    })
    ok('refuses to connect when the server offers no STARTTLS', err !== null,
      err ? err.message : 'connected anyway')

    // The pre-fix mapping, to show what the requirement prevents: the same
    // server accepts the login in the clear.
    const downgrade = await rejects(async () => {
      const client = new ImapFlow({
        host: HOST,
        port: IMAP_PORT,
        secure: false, // what imapFlowSecure() produced for 'starttls'
        auth: { user: LOGIN, pass: PASSWORD },
        logger: false
      })
      await client.connect()
      await client.logout()
    })
    ok('the old mapping would have logged in over plaintext (regression guard)',
      downgrade === null, downgrade ? `unexpected: ${downgrade.message}` : 'plaintext login succeeded')

    ok('ssl never sets the conflicting flag pair',
      imapConnectionSecurity('ssl').secure === true &&
        imapConnectionSecurity('ssl').doSTARTTLS === undefined)
  }

  // -------------------------------------------------------------------------
  section('Sync: messages on the server land in the local cache')
  // -------------------------------------------------------------------------
  const inbox = db.upsertFolder(account.id, 'INBOX', 'Inbox', 'inbox')
  {
    const client = rawClient()
    await client.connect()
    await seed(client, 'INBOX', ['Alpha', 'Bravo', 'Charlie'])

    const newCount = await sync.syncFolder(client, account.id, inbox.id, 'INBOX')
    ok('sync reports the new messages', newCount === 3, `newCount=${newCount}`)
    ok('all three are cached', db.countMessages(inbox.id) === 3, `cached=${db.countMessages(inbox.id)}`)

    const subjects = db.listMessages(inbox.id, 50, 0).map((m) => m.subject).sort()
    ok('subjects round-trip through the DB',
      subjects.join(',') === 'Alpha,Bravo,Charlie', subjects.join(','))

    const again = await sync.syncFolder(client, account.id, inbox.id, 'INBOX')
    ok('a second sync is a no-op', again === 0 && db.countMessages(inbox.id) === 3,
      `newCount=${again} cached=${db.countMessages(inbox.id)}`)
    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('Attachments: same-named parts must not overwrite each other')
  // -------------------------------------------------------------------------
  {
    // Two parts with one filename is ordinary mail — scanners, mail-merges, and
    // inline images that are all image001.png. The on-disk cache keyed both to
    // the same path, so fetching the second clobbered the first.
    const { ensureAttachmentLocal } = await import('../electron/services/attachment-fetch')
    const { readFileSync } = await import('fs')

    const client = rawClient()
    await client.connect()
    const box = 'DupeAttach'
    await client.mailboxCreate(box).catch(() => {})
    const folder = db.upsertFolder(account.id, box, box, 'custom')

    const boundary = 'orbitboundary123'
    const part = (body: string) =>
      [
        `--${boundary}`,
        'Content-Type: application/octet-stream; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        '',
        body,
        ''
      ].join('\r\n')

    await client.append(
      box,
      Buffer.from(
        [
          'From: Scanner <scanner@example.com>',
          `To: Me <${EMAIL}>`,
          'Subject: Two invoices, one name',
          'Message-ID: <dupe-attach@example.com>',
          `Date: ${new Date().toUTCString()}`,
          `Content-Type: multipart/mixed; boundary="${boundary}"`,
          '',
          part('FIRST-DOCUMENT-CONTENT'),
          part('SECOND-DOCUMENT-CONTENT-which-is-a-different-length'),
          `--${boundary}--`,
          ''
        ].join('\r\n')
      ),
      ['\\Seen']
    )
    await sync.syncFolder(client, account.id, folder.id, box)

    const msg = db.listMessages(folder.id, 10, 0).find((m) => m.subject === 'Two invoices, one name')
    const atts = msg ? db.listMessageAttachments(msg.id) : []
    ok('both attachments are recorded', atts.length === 2, `found=${atts.length}`)

    if (atts.length === 2) {
      const pathA = await ensureAttachmentLocal(atts[0].id)
      const pathB = await ensureAttachmentLocal(atts[1].id)
      ok('same-named attachments get distinct cache paths', pathA !== pathB,
        `${pathA.split('/').pop()} vs ${pathB.split('/').pop()}`)

      const a = readFileSync(pathA, 'utf8')
      const b = readFileSync(pathB, 'utf8')
      ok('each file keeps its own content',
        a.includes('FIRST-DOCUMENT') && b.includes('SECOND-DOCUMENT'),
        `A=${a.trim().slice(0, 24)} B=${b.trim().slice(0, 24)}`)

      // Re-fetching the first must not be affected by the second having landed.
      const again = readFileSync(await ensureAttachmentLocal(atts[0].id), 'utf8')
      ok('the first attachment survives fetching the second',
        again.includes('FIRST-DOCUMENT'), again.trim().slice(0, 24))
    }

    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('UIDVALIDITY: a reset rebuilds the cache instead of truncating it')
  // -------------------------------------------------------------------------
  {
    const client = rawClient()
    await client.connect()

    const box = 'ResyncBox'
    await client.mailboxCreate(box).catch(() => {})
    const folder = db.upsertFolder(account.id, box, box, 'custom')

    // A first-ever sync only takes the newest SYNC_BATCH_SIZE (200) — that is
    // the app's initial-sync depth. Cross that boundary the way a real account
    // does, by letting an incremental sync add newer mail on top, so the cache
    // holds more than one batch and truncation would be visible.
    const initial = Array.from({ length: 250 }, (_, i) => `Old${String(i + 1).padStart(3, '0')}`)
    await seed(client, box, initial)
    await sync.syncFolder(client, account.id, folder.id, box)
    const afterFirst = db.countMessages(folder.id)

    const later = Array.from({ length: 60 }, (_, i) => `New${String(i + 1).padStart(3, '0')}`)
    for (const [i, subject] of later.entries()) {
      // Dated in the future relative to the first batch so they sort as newest.
      await client.append(box, messageSource(subject, -(i + 1)), ['\\Seen'])
    }
    await sync.syncFolder(client, account.id, folder.id, box)

    const before = db.countMessages(folder.id)
    ok('cache spans more than one sync batch', before > 200,
      `cached=${before} (first sync capped at ${afterFirst})`)

    // Simulate the server reporting a new UIDVALIDITY. Done through the stored
    // value rather than by recreating the mailbox so the trigger is exact and
    // does not depend on how GreenMail allocates validity numbers.
    db.updateFolderSyncState(folder.id, { uidValidity: 999_111 })

    const rebuilt = await sync.syncFolder(client, account.id, folder.id, box)
    const after = db.countMessages(folder.id)
    ok('the whole cache is rebuilt, not cut to one batch', after === before,
      `restored=${after} of ${before} (newCount=${rebuilt})`)

    const restored = db.listMessages(folder.id, before + 50, 0).map((m) => m.subject)
    ok('the rebuilt rows are distinct messages, not duplicates',
      new Set(restored).size === after, `distinct=${new Set(restored).size} of ${after}`)
    ok('the new UIDVALIDITY is recorded',
      db.getFolderUidValidity(folder.id) !== 999_111, `${db.getFolderUidValidity(folder.id)}`)

    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('IDLE: push survives the server going away')
  // -------------------------------------------------------------------------
  {
    let pushes = 0
    idle.setIdleNewMailHandler(() => { pushes++ })
    idle.startIdleMonitoring()
    await sleep(3000)

    const client = rawClient()
    await client.connect()
    await seed(client, 'INBOX', ['PushBeforeDrop'])
    await client.logout()

    const deadline1 = Date.now() + 20_000
    while (pushes === 0 && Date.now() < deadline1) await sleep(500)
    ok('IDLE delivers a push before the drop', pushes > 0, `pushes=${pushes}`)

    // Drop every connection by restarting the server. GreenMail is in-memory,
    // so it comes back empty but with the same user.
    const beforeRestart = pushes
    restartGreenMail()
    await sleep(2000)

    // Reconnect is scheduled with backoff; the first retry is ~5s.
    const deadline2 = Date.now() + 60_000
    let reconnected = false
    while (!reconnected && Date.now() < deadline2) {
      await sleep(2000)
      const probe = rawClient()
      try {
        await probe.connect()
        await seed(probe, 'INBOX', [`PushAfterDrop${Date.now()}`])
        await probe.logout()
      } catch {
        continue // server still coming back up
      }
      await sleep(3000)
      if (pushes > beforeRestart) reconnected = true
    }
    ok('IDLE reconnects and pushes again after the server restarts', reconnected,
      `pushes=${pushes} (was ${beforeRestart})`)

    idle.stopIdleMonitoring()
  }

  // -------------------------------------------------------------------------
  section('Responsiveness: a click must not queue behind a full reconcile')
  // -------------------------------------------------------------------------
  {
    // imap-pool serializes operations per account, so a reconcile that holds
    // the lane across every folder blocks user actions for its whole duration.
    // Give the account enough folders for that to be measurable, then time a
    // mark-read issued while a reconcile is in flight.
    const client = rawClient()
    await client.connect()
    for (let i = 0; i < 12; i++) {
      const path = `Bulk${i}`
      await client.mailboxCreate(path).catch(() => {})
      await seed(client, path, [`Bulk ${i} message`])
      const f = db.upsertFolder(account.id, path, path, 'custom')
      await sync.syncFolder(client, account.id, f.id, path)
    }
    await client.logout()

    const target = db.listMessages(inbox.id, 1, 0)[0]
    const reconcile = sync.reconcileAccountFlags(account.id, 'imap')
    // Let the reconcile take the lane first.
    await sleep(50)

    const started = Date.now()
    await sync.markMessageReadOnServer(account.id, 'imap', 'INBOX', target.uid, true)
    const waited = Date.now() - started
    await reconcile

    // Local server, so a folder's reconcile is milliseconds; the point is that
    // the wait tracks one folder rather than all of them. Generous bound so the
    // check fails on the pathology, not on a slow machine.
    ok('mark-read is not blocked by the whole reconcile pass', waited < 2000,
      `waited=${waited}ms across ${db.listFolders(account.id).length} folders`)
  }

  // -------------------------------------------------------------------------
  section('Send: a sent message should be filed in Sent')
  // -------------------------------------------------------------------------
  {
    const { sendMail } = await import('../electron/services/smtp-send')
    const client = rawClient()
    await client.connect()
    await client.mailboxCreate('Sent').catch(() => {})
    const sent = db.upsertFolder(account.id, 'Sent', 'Sent', 'sent')

    const sendErr = await rejects(() =>
      sendMail(
        {
          accountId: account.id,
          to: EMAIL,
          bcc: 'hidden@example.com',
          subject: 'Integration send',
          bodyText: 'hello from the integration suite',
          bodyHtml: '<p>hello from the integration suite</p>'
        } as never,
        'imap'
      )
    )
    ok('SMTP submission succeeds', sendErr === null, sendErr?.message ?? '')

    await sync.syncFolder(client, account.id, sent.id, 'Sent')
    const inSent = db.listMessages(sent.id, 20, 0).filter((m) => m.subject === 'Integration send')
    ok('sent message is filed in the Sent folder', inSent.length === 1,
      `copies=${inSent.length}`)

    // The recipient's copy and the filed copy must be the same message, or
    // threading breaks: a reply's In-Reply-To would not match what is in Sent.
    // The message is addressed to the test user, so GreenMail delivers it back
    // into the same account's INBOX and both copies are visible here.
    const lock = await client.getMailboxLock('Sent')
    let sentMessageId: string | null = null
    try {
      for await (const msg of client.fetch({ all: true }, { envelope: true })) {
        if (msg.envelope?.subject === 'Integration send') {
          sentMessageId = msg.envelope.messageId ?? null
        }
      }
    } finally {
      lock.release()
    }
    ok('the filed copy carries a Message-ID', !!sentMessageId, sentMessageId ?? 'none')

    // GreenMail delivers to the local recipient too, so the same Message-ID
    // should be visible on the delivered side.
    const inboxLock = await client.getMailboxLock('INBOX')
    let deliveredMessageId: string | null = null
    try {
      for await (const msg of client.fetch({ all: true }, { envelope: true })) {
        if (msg.envelope?.subject === 'Integration send') {
          deliveredMessageId = msg.envelope.messageId ?? null
        }
      }
    } finally {
      inboxLock.release()
    }
    ok('filed copy and delivered copy share one Message-ID',
      !!sentMessageId && sentMessageId === deliveredMessageId,
      `sent=${sentMessageId} delivered=${deliveredMessageId}`)

    // The message is built by hand now, so guard the privacy property that
    // nodemailer normally owns: Bcc belongs in the SMTP envelope, never in the
    // headers, or every recipient learns who was blind-copied.
    const sentLock = await client.getMailboxLock('Sent')
    let sentSource = ''
    try {
      for await (const msg of client.fetch({ all: true }, { source: true, envelope: true })) {
        if (msg.envelope?.subject === 'Integration send') {
          sentSource = msg.source?.toString('utf8') ?? ''
        }
      }
    } finally {
      sentLock.release()
    }
    const headerBlock = sentSource.split('\r\n\r\n')[0] ?? ''
    ok('Bcc is not written into the message headers',
      headerBlock.length > 0 && !/^bcc:/im.test(headerBlock),
      /^bcc:/im.test(headerBlock) ? 'LEAKED' : 'absent, as it should be')

    await client.logout()
  }

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed, ${todos} todo (known-open bugs)`)
  rmSync(userData, { recursive: true, force: true })
  app.exit(failed === 0 ? 0 : 1)
}

app.disableHardwareAcceleration()
app.whenReady().then(() =>
  main().catch((err) => {
    console.error('\n[suite] crashed:', err)
    app.exit(1)
  })
)
