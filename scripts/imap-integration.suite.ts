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
  section('Account removal: AI tasks are deleted, not orphaned')
  // -------------------------------------------------------------------------
  {
    // sweep_tasks has no foreign key, so the account cascade does not reach it.
    // removeAccount must delete this account's tasks — per-folder ones, and
    // unified-inbox ones tied to its messages — while leaving other accounts'.
    const { getRawSqlite } = await import('../electron/db')
    const raw = getRawSqlite()

    const mkMessage = (id: string, folderId: string, acctId: string, uid: number) =>
      raw
        .prepare(
          `INSERT INTO messages (id, folder_id, account_id, uid, from_addr, to_addr, subject, snippet, date)
           VALUES (?, ?, ?, ?, 'a@b.c', 'd@e.f', 'subj', 'snip', 0)`
        )
        .run(id, folderId, acctId, uid)
    const mkTask = (folderId: string, id: string, sourceMessageId: string) =>
      raw
        .prepare(
          `INSERT INTO sweep_tasks (folder_id, id, task, priority, source_message_id, source_subject, source_from, created_at)
           VALUES (?, ?, 'do a thing', 'low', ?, 'subj', 'a@b.c', 0)`
        )
        .run(folderId, id, sourceMessageId)
    const taskExists = (folderId: string, id: string) =>
      !!raw.prepare('SELECT 1 FROM sweep_tasks WHERE folder_id = ? AND id = ?').get(folderId, id)

    const del = db.saveManualAccount('imap', {
      authType: 'password', email: 'removal-test@example.com', displayName: 'Del',
      username: 'd', password: 'p',
      incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
      outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
    })
    const keep = db.saveManualAccount('imap', {
      authType: 'password', email: 'keep-test@example.com', displayName: 'Keep',
      username: 'k', password: 'p',
      incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
      outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
    })
    const delFolder = db.upsertFolder(del.id, 'INBOX', 'Inbox', 'inbox')
    const keepFolder = db.upsertFolder(keep.id, 'INBOX', 'Inbox', 'inbox')
    mkMessage('del-msg', delFolder.id, del.id, 1)
    mkMessage('keep-msg', keepFolder.id, keep.id, 1)

    mkTask(delFolder.id, 'per-folder', 'del-msg')   // per-folder, this account
    mkTask('unified', 'unified-del', 'del-msg')      // unified, tied to this account
    mkTask('unified', 'unified-keep', 'keep-msg')    // unified, other account — must survive
    mkTask(keepFolder.id, 'keep-folder', 'keep-msg') // per-folder, other account — must survive

    db.removeAccount(del.id)

    ok('the removed account\'s per-folder task is gone', !taskExists(delFolder.id, 'per-folder'))
    ok('the removed account\'s unified task is gone', !taskExists('unified', 'unified-del'))
    ok('another account\'s unified task survives', taskExists('unified', 'unified-keep'))
    ok('another account\'s per-folder task survives', taskExists(keepFolder.id, 'keep-folder'))

    db.removeAccount(keep.id)
  }

  // -------------------------------------------------------------------------
  section('One-time cleanup: orphaned AI tasks from pre-fix deletions')
  // -------------------------------------------------------------------------
  {
    const { getRawSqlite, pruneOrphanedSweepTasks } = await import('../electron/db')
    const raw = getRawSqlite()

    const mkMessage = (id: string, folderId: string, acctId: string) =>
      raw
        .prepare(
          `INSERT INTO messages (id, folder_id, account_id, uid, from_addr, to_addr, subject, snippet, date)
           VALUES (?, ?, ?, 1, 'a@b.c', 'd@e.f', 'subj', 'snip', 0)`
        )
        .run(id, folderId, acctId)
    const mkTask = (folderId: string, id: string, sourceMessageId: string) =>
      raw
        .prepare(
          `INSERT INTO sweep_tasks (folder_id, id, task, priority, source_message_id, source_subject, source_from, created_at)
           VALUES (?, ?, 't', 'low', ?, 's', 'a@b.c', 0)`
        )
        .run(folderId, id, sourceMessageId)
    const taskExists = (folderId: string, id: string) =>
      !!raw.prepare('SELECT 1 FROM sweep_tasks WHERE folder_id = ? AND id = ?').get(folderId, id)

    // An account with a per-folder task, whose account row is then deleted
    // *directly* — bypassing removeAccount — to reproduce a pre-fix orphan.
    const orphanAcct = db.saveManualAccount('imap', {
      authType: 'password', email: 'orphan-src@example.com', displayName: 'O',
      username: 'o', password: 'p',
      incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
      outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
    })
    const orphanFolder = db.upsertFolder(orphanAcct.id, 'INBOX', 'Inbox', 'inbox')
    mkMessage('orphan-msg', orphanFolder.id, orphanAcct.id)
    mkTask(orphanFolder.id, 'orphan-task', 'orphan-msg')

    // A live account whose task must survive, plus a unified task whose source
    // message is missing — which the cleanup must NOT sweep (could be a valid
    // todo whose email aged out of the cache).
    const liveAcct = db.saveManualAccount('imap', {
      authType: 'password', email: 'live-src@example.com', displayName: 'L',
      username: 'l', password: 'p',
      incoming: { host: HOST, port: IMAP_PORT, security: 'none' },
      outgoing: { host: HOST, port: SMTP_PORT, security: 'none' }
    })
    const liveFolder = db.upsertFolder(liveAcct.id, 'INBOX', 'Inbox', 'inbox')
    mkTask(liveFolder.id, 'live-task', 'nonexistent')
    mkTask('unified', 'unified-ghost', 'nonexistent') // missing message, must survive

    // Delete the orphan account row directly (cascades its folder + message,
    // leaves the task) — this is the pre-#56 state the migration cleans up.
    raw.prepare('DELETE FROM accounts WHERE id = ?').run(orphanAcct.id)
    ok('the orphan exists before cleanup (folder gone, task remains)',
      taskExists(orphanFolder.id, 'orphan-task') &&
        !raw.prepare('SELECT 1 FROM folders WHERE id = ?').get(orphanFolder.id))

    // The suite's fresh DB already ran the guarded cleanup once (on empty data),
    // so clear the flag to run it against this fixture.
    raw.prepare("DELETE FROM app_preferences WHERE key = 'sweep_task_orphan_cleanup_v1'").run()
    pruneOrphanedSweepTasks(raw)

    ok('cleanup removes the orphaned per-folder task', !taskExists(orphanFolder.id, 'orphan-task'))
    ok('a live account\'s task survives', taskExists(liveFolder.id, 'live-task'))
    ok('a unified task with a missing message is NOT swept', taskExists('unified', 'unified-ghost'))

    // Guarded: a second run is a no-op and does not touch a fresh orphan.
    mkTask(orphanFolder.id, 'orphan-2', 'orphan-msg')
    pruneOrphanedSweepTasks(raw)
    ok('the cleanup is guarded — a second call does nothing',
      taskExists(orphanFolder.id, 'orphan-2'))

    // Cleanup fixtures.
    raw.prepare("DELETE FROM sweep_tasks WHERE folder_id = ? OR id IN ('unified-ghost')").run(orphanFolder.id)
    raw.prepare("DELETE FROM sweep_tasks WHERE folder_id = 'unified' AND id = 'unified-ghost'").run()
    db.removeAccount(liveAcct.id)
  }

  // -------------------------------------------------------------------------
  section('DB maintenance: reclaim freelist space when it grows large')
  // -------------------------------------------------------------------------
  {
    const { getRawSqlite, shouldReclaimFreelist, reclaimFreelistIfLarge } =
      await import('../electron/db')

    // Decision logic — the numbers include a real 3.3k-message profile.
    ok('vacuums a large, mostly-free file', shouldReclaimFreelist(80697, 29872, 4096))
    ok('does not vacuum a freshly compacted file', !shouldReclaimFreelist(50638, 0, 4096))
    ok('does not vacuum a small file even when its free fraction is high',
      !shouldReclaimFreelist(1000, 900, 4096)) // 3.6MB free — not worth a rewrite
    ok('the 25% / 20MB threshold is a real boundary',
      shouldReclaimFreelist(80000, 20000, 4096) && !shouldReclaimFreelist(80000, 19999, 4096))

    // Real end-to-end: bloat the database well past the threshold, drop it to
    // the freelist, then reclaim and confirm the file actually shrank.
    const raw = getRawSqlite()
    raw.exec('CREATE TABLE _vac_bloat (id INTEGER PRIMARY KEY, blob TEXT)')
    const chunk = 'x'.repeat(4000)
    const insert = raw.prepare('INSERT INTO _vac_bloat (blob) VALUES (?)')
    raw.transaction(() => {
      for (let i = 0; i < 7000; i++) insert.run(chunk) // ~28MB
    })()
    raw.exec('DROP TABLE _vac_bloat') // pages move to the freelist

    const pagesBefore = raw.pragma('page_count', { simple: true }) as number
    const reclaimed = reclaimFreelistIfLarge()
    const pagesAfter = raw.pragma('page_count', { simple: true }) as number
    const freelistAfter = raw.pragma('freelist_count', { simple: true }) as number

    ok('reclaims the space when the freelist is large', reclaimed > 20 * 1024 * 1024,
      `reclaimed=${Math.round(reclaimed / 1024 / 1024)}MB`)
    ok('the file shrinks and the freelist is zeroed',
      pagesAfter < pagesBefore && freelistAfter === 0,
      `pages ${pagesBefore} -> ${pagesAfter}, freelist ${freelistAfter}`)
    ok('a second call is a no-op once compacted', reclaimFreelistIfLarge() === 0)
  }

  // -------------------------------------------------------------------------
  section('Search: body is searched via the plain-text column, not raw HTML')
  // -------------------------------------------------------------------------
  {
    const { getRawSqlite } = await import('../electron/db')
    const raw = getRawSqlite()
    const box = 'SearchBox'
    const client = rawClient()
    await client.connect()
    await client.mailboxCreate(box).catch(() => {})
    const folder = db.upsertFolder(account.id, box, box, 'custom')

    // Sync a message whose body content lives only in HTML.
    await client.append(
      box,
      Buffer.from(
        [
          'From: Sender <s@example.com>',
          `To: Me <${EMAIL}>`,
          'Subject: Newsletter',
          'Message-ID: <search-html@example.com>',
          `Date: ${new Date().toUTCString()}`,
          'Content-Type: text/html; charset=utf-8',
          '',
          '<div><p>The <b>quarterly</b> figures are attached.</p></div>',
          ''
        ].join('\r\n')
      ),
      ['\\Seen']
    )
    await sync.syncFolder(client, account.id, folder.id, box)
    const msg = db.listMessages(folder.id, 10, 0).find((m) => m.subject === 'Newsletter')
    ok('the HTML message synced', !!msg)

    // Upsert populates search_text — a word from inside the HTML body is found.
    const found = db.searchMessages('quarterly', account.id, 'body', 50)
    ok('search finds a word from the HTML body', found.some((m) => m.id === msg?.id),
      `${found.length} hit(s)`)

    // ...and markup is NOT matched: a tag name from the raw HTML must not hit.
    const tagHit = db.searchMessages('div', account.id, 'body', 50)
    ok('an HTML tag name is not a match', !tagHit.some((m) => m.id === msg?.id))

    // Fallback path: null out search_text to simulate a not-yet-backfilled row,
    // and confirm the body_html fallback still finds it.
    raw.prepare('UPDATE messages SET search_text = NULL WHERE id = ?').run(msg!.id)
    ok('un-backfilled rows still match via the body_html fallback',
      db.searchMessages('quarterly', account.id, 'body', 50).some((m) => m.id === msg?.id))

    // The background backfill repopulates it.
    const processed = db.backfillSearchTextBatch()
    const stored = raw
      .prepare('SELECT search_text FROM messages WHERE id = ?')
      .get(msg!.id) as { search_text: string | null }
    ok('the backfill repopulates search_text', processed >= 1 && !!stored.search_text?.includes('quarterly'))

    // The renderer-supplied limit is clamped.
    const many = db.searchMessages('a', account.id, 'all', 1_000_000)
    ok('an over-large limit is clamped', many.length <= 200, `returned ${many.length}`)

    // A literal `_` in the query must match a literal underscore, not act as
    // LIKE's single-char wildcard (which used to make `foo_bar` match `fooXbar`).
    const insProbe = raw.prepare(
      `INSERT INTO messages (id, folder_id, account_id, uid, from_addr, to_addr, subject, snippet, date, search_text)
       VALUES (@id, @f, @a, @uid, 's@example.com', @to, @subj, 'snip', @date, @st)`
    )
    insProbe.run({ id: 'us-literal', f: folder.id, a: account.id, uid: 9001, to: EMAIL, subj: 'US literal', date: 1000, st: 'order code foo_bar shipped' })
    insProbe.run({ id: 'us-wild', f: folder.id, a: account.id, uid: 9002, to: EMAIL, subj: 'US wildcard', date: 1000, st: 'order code fooXbar shipped' })

    const underscore = db.searchMessages('foo_bar', account.id, 'body', 50).map((m) => m.id)
    ok('a literal _ is not treated as a wildcard',
      underscore.includes('us-literal') && !underscore.includes('us-wild'),
      underscore.join(', ') || 'no hits')

    raw.prepare("DELETE FROM messages WHERE id IN ('us-literal', 'us-wild')").run()

    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('Folder types: SPECIAL-USE decides, not the English folder name')
  // -------------------------------------------------------------------------
  {
    // imapflow hands back `specialUse` as a single string ("\\Trash"), not an
    // array. Iterating it as an array walked the characters, so SPECIAL-USE
    // never matched and every folder was typed from its English name. On an
    // en-GB Gmail account that typed the real Trash ([Gmail]/Bin) as `custom`
    // while a legacy user folder named "Deleted Items" claimed `trash` — so
    // "delete" moved mail to an ordinary label, which on Gmail keeps every other
    // label, leaving the message in All Mail, search and thread views.
    const { detectFolderType, detectFolderTypes } = await import('../electron/services/imap-sync')

    ok('a string special-use is honoured',
      detectFolderType('Bin', '\\Trash') === 'trash',
      detectFolderType('Bin', '\\Trash'))
    ok('an array special-use still works',
      detectFolderType('Papierkorb', ['\\Trash']) === 'trash')
    ok('flags are matched case-insensitively',
      detectFolderType('Bin', '\\trash') === 'trash')
    ok('an unflagged folder still falls back to its name',
      detectFolderType('Deleted Items') === 'trash')
    ok('Gmail’s en-GB Bin is trash even without a flag',
      detectFolderType('Bin') === 'trash')
    ok('an ordinary folder stays custom', detectFolderType('Rotary') === 'custom')

    // The account-wide pass: the server's flag outranks a name match elsewhere.
    const mailboxes = [
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Bin', path: '[Gmail]/Bin', specialUse: '\\Trash' },
      { name: 'Deleted Items', path: 'Deleted Items' },
      { name: 'All Mail', path: '[Gmail]/All Mail', specialUse: '\\All' }
    ]
    const types = detectFolderTypes(mailboxes)
    ok('the flagged mailbox owns the trash role',
      types.get('[Gmail]/Bin') === 'trash', String(types.get('[Gmail]/Bin')))
    ok('the name-matched impostor is demoted to custom',
      types.get('Deleted Items') === 'custom', String(types.get('Deleted Items')))
    ok('unrelated roles are unaffected',
      types.get('INBOX') === 'inbox' && types.get('[Gmail]/All Mail') === 'custom')

    // With no server flag anywhere, the name fallback still names a Trash.
    const unflagged = detectFolderTypes([
      { name: 'INBOX', path: 'INBOX' },
      { name: 'Deleted Items', path: 'Deleted Items' }
    ])
    ok('without SPECIAL-USE the name match still wins the role',
      unflagged.get('Deleted Items') === 'trash', String(unflagged.get('Deleted Items')))

    // A mailbox imported under INBOX (delegated, or migrated from an old IMAP
    // account) offers the same role names as the account's own folders. The
    // account's own — shallower — folder must win, or Sent shows an empty
    // stranger's folder and sent copies file into it. Listed nested-first here
    // because that is the order that used to decide it.
    // Note the grafted mailboxes carry their *own* SPECIAL-USE flags — this is
    // the real shape of an Exchange account with an old IMAP tree imported under
    // INBOX, and it is why depth has to break ties within the flagged class too
    // rather than flags alone deciding.
    const grafted = detectFolderTypes([
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Sent Items', path: 'INBOX/admin/Sent Items', specialUse: '\\Sent' },
      { name: 'Junk Email', path: 'INBOX/admin/Junk Email', specialUse: '\\Junk' },
      { name: 'sent-mail', path: 'INBOX/info/mail/sent-mail' },
      { name: 'Sent Items', path: 'Sent Items', specialUse: '\\Sent' },
      { name: 'Deleted Items', path: 'Deleted Items' },
      { name: 'Trash', path: 'Trash' }
    ])
    ok('the account’s own Sent wins over a grafted copy, both flagged',
      grafted.get('Sent Items') === 'sent', String(grafted.get('Sent Items')))
    ok('the grafted copy is demoted',
      grafted.get('INBOX/admin/Sent Items') === 'custom',
      String(grafted.get('INBOX/admin/Sent Items')))
    ok('a nested role with no shallower rival still takes it',
      grafted.get('INBOX/admin/Junk Email') === 'junk',
      String(grafted.get('INBOX/admin/Junk Email')))
    ok('an unflagged lookalike deeper still is left alone',
      grafted.get('INBOX/info/mail/sent-mail') === 'custom',
      String(grafted.get('INBOX/info/mail/sent-mail')))
    ok('among equally shallow rivals the first listed keeps the role',
      grafted.get('Deleted Items') === 'trash' && grafted.get('Trash') === 'custom',
      `${grafted.get('Deleted Items')} / ${grafted.get('Trash')}`)

    // Depth must not outrank a flag: Gmail's Bin is nested and still correct.
    const gmail = detectFolderTypes([
      { name: 'INBOX', path: 'INBOX', specialUse: '\\Inbox' },
      { name: 'Deleted Items', path: 'Deleted Items' },
      { name: 'Bin', path: '[Gmail]/Bin', specialUse: '\\Trash' }
    ])
    ok('a flagged deep folder still beats a shallow name match',
      gmail.get('[Gmail]/Bin') === 'trash' && gmail.get('Deleted Items') === 'custom',
      `${gmail.get('[Gmail]/Bin')} / ${gmail.get('Deleted Items')}`)

    // Servers using '.' as the hierarchy delimiter must measure depth with it.
    const dotted = detectFolderTypes([
      { name: 'Sent', path: 'INBOX.shared.Sent', delimiter: '.' },
      { name: 'Sent', path: 'Sent', delimiter: '.' }
    ])
    ok('depth respects the server’s hierarchy delimiter',
      dotted.get('Sent') === 'sent' && dotted.get('INBOX.shared.Sent') === 'custom',
      `${dotted.get('Sent')} / ${dotted.get('INBOX.shared.Sent')}`)
  }

  // -------------------------------------------------------------------------
  section('Folder types: an existing folder is re-typed, not frozen')
  // -------------------------------------------------------------------------
  {
    // The type used to be set only on insert, so a folder mis-typed once stayed
    // that way and no detection fix could reach an existing install.
    const first = db.upsertFolder(account.id, '[Gmail]/Retype', 'Retype', 'custom')
    ok('starts as first detected', first.type === 'custom', first.type)

    const second = db.upsertFolder(account.id, '[Gmail]/Retype', 'Retype', 'trash')
    ok('the corrected type is returned', second.type === 'trash', second.type)
    ok('it is the same folder row, not a duplicate', second.id === first.id)

    const listed = db.listFolders(account.id).find((f) => f.imapPath === '[Gmail]/Retype')
    ok('the corrected type is persisted', listed?.type === 'trash', String(listed?.type))
  }

  // -------------------------------------------------------------------------
  section('Delete: a later sync must not re-import the deleted message')
  // -------------------------------------------------------------------------
  {
    // Mirrors what main.ts does — server op first, then drop the local row —
    // and then runs the sync that a poll/IDLE would run, to prove the message
    // does not come back. Deleting the *newest* message is the interesting case:
    // it lowers the folder's local max UID, and the next sync searches
    // `maxLocalUid + 1 : *`, which in IMAP still matches the highest existing
    // message when that range starts past the end.
    const box = 'DeleteResync'
    const client = rawClient()
    await client.connect()
    await client.mailboxCreate(box).catch(() => {})
    const folder = db.upsertFolder(account.id, box, box, 'custom')
    await seed(client, box, ['Keep one', 'Keep two', 'Delete me'])
    await sync.syncFolder(client, account.id, folder.id, box)

    const cached = db.listMessages(folder.id, 50, 0)
    ok('all three synced', cached.length === 3, `cached=${cached.length}`)
    const target = cached.find((m) => m.subject === 'Delete me')
    ok('the newest message is the delete target', !!target && target.uid === Math.max(...cached.map((m) => m.uid)))

    await sync.deleteMessageOnServer(account.id, account.provider, box, target!.uid)
    db.deleteMessage(target!.id)
    ok('it is gone locally right after the delete',
      db.listMessages(folder.id, 50, 0).length === 2)

    // The poll that follows every delete, and every one after that.
    await sync.syncFolder(client, account.id, folder.id, box)
    await sync.syncFolder(client, account.id, folder.id, box)
    const after = db.listMessages(folder.id, 50, 0)
    ok('a later sync does not re-import it',
      !after.some((m) => m.subject === 'Delete me'),
      after.map((m) => m.subject).join(', '))
    ok('and does not duplicate the survivors', after.length === 2, `cached=${after.length}`)

    // New mail after the delete must still arrive — the guard must not wedge the
    // folder's UID watermark.
    await seed(client, box, ['Arrived later'])
    await sync.syncFolder(client, account.id, folder.id, box)
    const later = db.listMessages(folder.id, 50, 0)
    ok('mail arriving after the delete still syncs',
      later.some((m) => m.subject === 'Arrived later'), `cached=${later.length}`)

    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('Move: the message lands in the target and stays out of the source')
  // -------------------------------------------------------------------------
  {
    // Delete-to-Trash is a move, so this is the path the Delete key really takes.
    const src = 'MoveSrc'
    const dst = 'MoveDst'
    const client = rawClient()
    await client.connect()
    await client.mailboxCreate(src).catch(() => {})
    await client.mailboxCreate(dst).catch(() => {})
    const srcFolder = db.upsertFolder(account.id, src, src, 'custom')
    const dstFolder = db.upsertFolder(account.id, dst, dst, 'trash')
    await seed(client, src, ['Stays put', 'Moves away'])
    await sync.syncFolder(client, account.id, srcFolder.id, src)

    const moving = db.listMessages(srcFolder.id, 50, 0).find((m) => m.subject === 'Moves away')
    ok('the message to move is cached', !!moving)

    await sync.moveMessageOnServer(account.id, account.provider, src, dst, moving!.uid)
    db.deleteMessage(moving!.id)

    await sync.syncFolder(client, account.id, srcFolder.id, src)
    await sync.syncFolder(client, account.id, dstFolder.id, dst)
    const srcAfter = db.listMessages(srcFolder.id, 50, 0)
    const dstAfter = db.listMessages(dstFolder.id, 50, 0)
    ok('it does not come back in the source folder',
      !srcAfter.some((m) => m.subject === 'Moves away'),
      srcAfter.map((m) => m.subject).join(', '))
    ok('it is cached in the destination exactly once',
      dstAfter.filter((m) => m.subject === 'Moves away').length === 1,
      dstAfter.map((m) => m.subject).join(', '))

    await client.logout()
  }

  // -------------------------------------------------------------------------
  section('Sent folders: a row names the recipient, not us')
  // -------------------------------------------------------------------------
  {
    // In Sent the sender is always the account owner, so the useful label is who
    // the mail went to. Thread rows get that from listThreads; the renderer does
    // the same per row for flat/search views from MessageSummary.to.
    const { getRawSqlite } = await import('../electron/db')
    const { collectDisplayNames, splitAddressList } = await import('../shared/addresses')
    const raw = getRawSqlite()

    const sent = db.upsertFolder(account.id, 'SentLabels', 'SentLabels', 'sent')
    const archive = db.upsertFolder(account.id, 'ArchiveLabels', 'ArchiveLabels', 'custom')
    const ins = raw.prepare(
      `INSERT INTO messages (id, folder_id, account_id, uid, message_id, thread_id, from_addr, to_addr, subject, snippet, date, is_read)
       VALUES (@id, @f, @a, @uid, @mid, @tid, @from, @to, @subj, 'snip', @date, 1)`
    )
    const me = `Me <${EMAIL}>`
    ins.run({ id: 'sent-1', f: sent.id, a: account.id, uid: 9101, mid: '<sent-1@x>', tid: 'thr-sent',
      from: me, to: '"Doe, Jane" <jane@example.com>, bob@example.com', subj: 'Quote', date: 3000 })
    // The Gmail shape: the same message also filed under a non-Sent label. The
    // Message-ID dedupe can keep this copy and drop the Sent one, so the Sent
    // label must be built from the copies that live in the folder being viewed.
    ins.run({ id: 'sent-1-archive', f: archive.id, a: account.id, uid: 9102, mid: '<sent-1@x>', tid: 'thr-sent',
      from: me, to: 'jane@example.com', subj: 'Quote', date: 3000 })
    // Jane replies — her copy is in Archive, and must not become the Sent label.
    ins.run({ id: 'reply-1', f: archive.id, a: account.id, uid: 9103, mid: '<reply-1@x>', tid: 'thr-sent',
      from: 'Jane Doe <jane@example.com>', to: me, subj: 'Re: Quote', date: 4000 })

    const sentThread = db.listThreads(sent.id, 10, 0).find((t) => t.threadId === 'thr-sent')
    ok('a Sent thread is labelled with the recipients',
      !!sentThread && sentThread.participants.join(', ') === 'Doe, Jane, bob@example.com',
      sentThread?.participants.join(' | ') ?? 'thread missing')

    const archiveThread = db.listThreads(archive.id, 10, 0).find((t) => t.threadId === 'thr-sent')
    ok('the same thread elsewhere is still labelled with the senders',
      !!archiveThread && archiveThread.participants.includes('Jane Doe'),
      archiveThread?.participants.join(' | ') ?? 'thread missing')

    // The renderer reads MessageSummary.to for flat/search rows.
    const flat = db.listMessages(sent.id, 10, 0).find((m) => m.id === 'sent-1')
    ok('the flat row carries the recipient list',
      collectDisplayNames([flat?.to ?? '']).join(', ') === 'Doe, Jane, bob@example.com',
      flat?.to ?? 'row missing')

    // A comma inside a quoted display name does not split the address list.
    ok('a quoted display name is one address, not two',
      splitAddressList('"Doe, Jane" <jane@example.com>, bob@example.com').length === 2)
    // One person written two ways is one participant, and the named form wins.
    ok('the same address written two ways is listed once',
      collectDisplayNames(['jane@example.com', 'Jane Doe <JANE@example.com>']).join(', ') === 'Jane Doe')

    raw.prepare("DELETE FROM messages WHERE id IN ('sent-1', 'sent-1-archive', 'reply-1')").run()
  }

  // -------------------------------------------------------------------------
  section('POP3: a stalled server times out instead of wedging all sync')
  // -------------------------------------------------------------------------
  {
    const { pop3ClientOptions } = await import('../electron/services/account-credentials')

    // Config guard: the timeout must be present. node-pop3 arms its socket timer
    // only when one is supplied, and without it a stalled POP3 op hangs forever
    // with syncStatus.syncing stuck true — wedging sync for every account.
    const opts = pop3ClientOptions(
      { host: 'h', port: 110, security: 'ssl' },
      'u',
      'p'
    ) as { timeout?: number }
    ok('pop3 client options include a socket timeout',
      typeof opts.timeout === 'number' && opts.timeout > 0, `timeout=${opts.timeout}`)

    // End-to-end: a server that accepts the TCP connection but never sends the
    // POP3 greeting. Without a timeout, UIDL() would hang forever. With one, it
    // rejects — which is what lets pollForNewMessages' try/catch recover.
    const net = await import('net')
    const Pop3Command = ((await import('node-pop3')) as { default: new (o: unknown) => { UIDL: () => Promise<unknown> } }).default
    const server = net.createServer(() => {
      // accept the socket, send nothing — the classic stall
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port

    const pop3 = new Pop3Command({
      host: '127.0.0.1',
      port,
      user: 'x',
      password: 'y',
      tls: false,
      timeout: 800 // short, for the test — production uses 60s
    })
    const started = Date.now()
    let rejected = false
    try {
      await pop3.UIDL()
    } catch {
      rejected = true
    }
    const elapsed = Date.now() - started
    ok('a silent POP3 server rejects rather than hanging', rejected && elapsed < 5000,
      `rejected=${rejected} after ${elapsed}ms`)

    server.close()
  }

  // -------------------------------------------------------------------------
  section('Remote images: the sender allowlist persists and normalizes')
  // -------------------------------------------------------------------------
  {
    // The sanitizer blocking is renderer-side (needs a DOM) and is verified with
    // jsdom, as the sanitizer itself was (#29). This covers the main-side half:
    // the per-sender allowlist that the reader consults.
    const prefs = await import('../electron/services/preferences-service')

    prefs.allowSenderImages('"Stripe" <News@Stripe.com>')
    const after = prefs.getAppState().imageAllowedSenders
    ok('allowSenderImages stores a normalized address (name stripped, lowercased)',
      after.includes('news@stripe.com'), after.join(', '))

    prefs.allowSenderImages('news@stripe.com')
    const dupes = prefs
      .getAppState()
      .imageAllowedSenders.filter((e) => e === 'news@stripe.com').length
    ok('the same sender is not added twice', dupes === 1, `count=${dupes}`)

    // Survives a fresh read of the persisted blob (not just the in-memory cache).
    const { getRawSqlite } = await import('../electron/db')
    const raw = getRawSqlite().prepare("SELECT value FROM app_preferences WHERE key = 'app_state'").get() as
      | { value: string }
      | undefined
    ok('the allowlist is persisted to app_preferences',
      !!raw && JSON.parse(raw.value).imageAllowedSenders?.includes('news@stripe.com'))
  }

  // -------------------------------------------------------------------------
  section('Attachments: message_id lookups use an index, not a full scan')
  // -------------------------------------------------------------------------
  {
    // Every attachment read is by message_id, and the ON DELETE CASCADE from
    // messages walks the same key — so without the index a prune of N messages
    // is N full scans of attachments. An index that exists but the planner does
    // not pick is worthless, so this asserts the plan, not just the schema.
    const { getRawSqlite } = await import('../electron/db')
    const raw = getRawSqlite()

    const idx = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'attachments_message_id_idx'"
      )
      .get()
    ok('attachments_message_id_idx exists', !!idx)

    const plan = raw
      .prepare('EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE message_id = ?')
      .all('any') as Array<{ detail: string }>
    const detail = plan.map((p) => p.detail).join(' | ')
    ok('a message_id lookup uses the index rather than scanning',
      /USING (?:COVERING )?INDEX attachments_message_id_idx/.test(detail) &&
        !/\bSCAN attachments\b/.test(detail),
      detail)
  }

  // -------------------------------------------------------------------------
  section('Startup: duplicate (folder_id, uid) rows are deduped so the index builds')
  // -------------------------------------------------------------------------
  {
    // A pre-constraint DB can hold duplicate (folder_id, uid) rows; building the
    // UNIQUE index over them throws out of startup, every launch. dedupe removes
    // them first, keeping the row that carries the most work.
    const { getRawSqlite, dedupeMessagesByFolderUid } = await import('../electron/db')
    const raw = getRawSqlite()
    const folder = db.upsertFolder(account.id, 'DedupeUid', 'DedupeUid', 'custom')

    // Reproduce the broken state: drop the unique index, insert a duplicate pair
    // (the older row carries AI analysis; the newer one does not) plus a singleton.
    raw.exec('DROP INDEX IF EXISTS messages_folder_uid_idx')
    const ins = raw.prepare(
      `INSERT INTO messages (id, folder_id, account_id, uid, from_addr, to_addr, subject, snippet, date, ai_analysis)
       VALUES (@id, @folder, @account, @uid, 'a@x', 'b@y', 'Dupe', 'snip', @date, @ai)`
    )
    ins.run({ id: 'dup-old-ai', folder: folder.id, account: account.id, uid: 42, date: 1000, ai: '{"summary":"keep"}' })
    ins.run({ id: 'dup-new', folder: folder.id, account: account.id, uid: 42, date: 2000, ai: null })
    ins.run({ id: 'solo', folder: folder.id, account: account.id, uid: 43, date: 1000, ai: null })

    let threw = false
    try {
      raw.exec('CREATE UNIQUE INDEX messages_folder_uid_probe ON messages(folder_id, uid)')
    } catch {
      threw = true
    }
    raw.exec('DROP INDEX IF EXISTS messages_folder_uid_probe')
    ok('a duplicate (folder_id, uid) blocks the unique index', threw)

    const removed = dedupeMessagesByFolderUid(raw)
    ok('dedupe removes exactly the surplus row', removed === 1, `removed=${removed}`)

    const survivors = raw
      .prepare('SELECT id FROM messages WHERE folder_id = ? AND uid = 42')
      .all(folder.id) as Array<{ id: string }>
    ok('one row survives per (folder_id, uid)', survivors.length === 1, `n=${survivors.length}`)
    ok('the AI-carrying duplicate is the survivor', survivors[0]?.id === 'dup-old-ai', survivors[0]?.id)

    let built = true
    try {
      raw.exec('CREATE UNIQUE INDEX IF NOT EXISTS messages_folder_uid_idx ON messages(folder_id, uid)')
    } catch {
      built = false
    }
    ok('the unique index builds once deduped', built)
    ok('a healthy table dedupes to zero', dedupeMessagesByFolderUid(raw) === 0)

    // Cleanup: remove the test folder and its rows so later sections are unaffected.
    raw.prepare('DELETE FROM messages WHERE folder_id = ?').run(folder.id)
    raw.prepare('DELETE FROM folders WHERE id = ?').run(folder.id)
  }

  // -------------------------------------------------------------------------
  section('Autoconfig: a STARTTLS socketType is not misread as implicit SSL')
  // -------------------------------------------------------------------------
  {
    // 'starttls'.includes('tls') is true, so a naive SSL-first check claimed a
    // STARTTLS socketType and stored the account as implicit SSL — which then
    // hangs on a TLS handshake against the plaintext-upgrade port (143/587).
    const { parseAutoconfigXml } = await import('../electron/services/mail-autoconfig')
    const xml = (inType: string, inSock: string, inPort: number, outSock: string, outPort: number) =>
      `<clientConfig><emailProvider>` +
      `<incomingServer type="${inType}"><hostname>mail.example.com</hostname>` +
      `<port>${inPort}</port><socketType>${inSock}</socketType></incomingServer>` +
      `<outgoingServer type="smtp"><hostname>smtp.example.com</hostname>` +
      `<port>${outPort}</port><socketType>${outSock}</socketType></outgoingServer>` +
      `</emailProvider></clientConfig>`

    const starttls = parseAutoconfigXml(xml('imap', 'STARTTLS', 143, 'STARTTLS', 587))
    ok('a STARTTLS incoming socketType maps to starttls, not ssl',
      starttls?.incoming?.security === 'starttls', `got ${starttls?.incoming?.security}`)
    ok('a STARTTLS outgoing socketType maps to starttls, not ssl',
      starttls?.outgoing?.security === 'starttls', `got ${starttls?.outgoing?.security}`)

    const ssl = parseAutoconfigXml(xml('imap', 'SSL', 993, 'SSL', 465))
    ok('an SSL socketType still maps to ssl',
      ssl?.incoming?.security === 'ssl' && ssl?.outgoing?.security === 'ssl',
      `in=${ssl?.incoming?.security} out=${ssl?.outgoing?.security}`)

    // No socketType tag → the parser's own defaults (incoming SSL, outgoing
    // STARTTLS), which win over the port before parseSecurity's fallback.
    const noSock = parseAutoconfigXml(
      `<clientConfig><emailProvider>` +
        `<incomingServer type="imap"><hostname>mail.example.com</hostname><port>993</port></incomingServer>` +
        `<outgoingServer type="smtp"><hostname>smtp.example.com</hostname><port>587</port></outgoingServer>` +
        `</emailProvider></clientConfig>`
    )
    ok('an absent socketType uses the parser defaults (incoming ssl, outgoing starttls)',
      noSock?.incoming?.security === 'ssl' && noSock?.outgoing?.security === 'starttls',
      `in=${noSock?.incoming?.security} out=${noSock?.outgoing?.security}`)

    // An unrecognized socketType (no scheme in the string) is where the
    // well-known-port fallback actually kicks in.
    const plain = parseAutoconfigXml(xml('imap', 'plain', 143, 'plain', 465))
    ok('an unrecognized socketType falls back to the port (143→starttls, 465→ssl)',
      plain?.incoming?.security === 'starttls' && plain?.outgoing?.security === 'ssl',
      `in=${plain?.incoming?.security} out=${plain?.outgoing?.security}`)
  }

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
  section('Attachments: metadata reduction preserves fields and drops the buffer')
  // -------------------------------------------------------------------------
  {
    // Sync reduces each parsed attachment to metadata as soon as it is parsed,
    // so the content Buffer is freed rather than retained across the batch. This
    // pins the exact fields the old inline path recorded, including the size
    // fallback that reads content.length before the Buffer is let go.
    const { toAttachmentMeta } = await import('../electron/services/attachment-fetch')

    const explicit = toAttachmentMeta({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      size: 1234,
      content: Buffer.from('xx')
    } as never)
    ok('explicit filename/type/size are preserved',
      explicit.filename === 'invoice.pdf' &&
        explicit.contentType === 'application/pdf' &&
        explicit.size === 1234)

    const fallback = toAttachmentMeta({ content: Buffer.from('hello') } as never)
    ok('missing size falls back to content length; name/type default',
      fallback.size === 5 &&
        fallback.filename === 'attachment' &&
        fallback.contentType === 'application/octet-stream',
      JSON.stringify(fallback))

    ok('the reduced metadata holds no content buffer',
      !Buffer.isBuffer((fallback as { content?: unknown }).content))
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
