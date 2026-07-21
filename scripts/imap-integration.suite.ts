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
          to: 'someone@example.com',
          subject: 'Integration send',
          bodyText: 'hello from the integration suite',
          bodyHtml: '<p>hello from the integration suite</p>'
        } as never,
        'imap'
      )
    )
    ok('SMTP submission succeeds', sendErr === null, sendErr?.message ?? '')

    await sync.syncFolder(client, account.id, sent.id, 'Sent')
    const filed = db.listMessages(sent.id, 20, 0).some((m) => m.subject === 'Integration send')
    // Open finding: appendToSentFolder is guarded on `info.message`, which the
    // SMTP transport never sets, so nothing is ever appended. Providers that
    // auto-file (Gmail/O365) hide this; a plain IMAP+SMTP account does not.
    todo('sent message is filed in the Sent folder', filed,
      filed ? '' : 'not filed — see TODO.md "Sent mail never filed for manual IMAP accounts"')

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
