// Renderer-store regression tests, run under plain node.
//
// The store is the one piece of app logic the GreenMail suite cannot reach: it
// lives in the renderer and talks to the main process only through
// `window.orbitMail`. That makes it cheap to test in isolation — bundle it with
// esbuild, stub the IPC surface, and drive the exported actions directly.
//
// What is covered here is the delete/refresh race: the main process removes the
// local SQLite row only *after* the IMAP round-trip returns, so between the
// optimistic removal and the server's answer the list says "gone" while the DB
// still says "here". Any refresh in that window (the `sync:messagesUpdated`
// debounce, the sync-complete subscription, a background poll, an IDLE push)
// used to reload the page from the DB and resurrect the row.

import { build } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = mkdtempSync(join(tmpdir(), 'orbit-store-'))
const outfile = join(outDir, 'mailStore.cjs')

let failures = 0
function ok(label, condition, detail = '') {
  console.log(`  ${condition ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}
function section(name) {
  console.log(`\n${name}`)
}

function summaryRow(id, uid, date, subject) {
  return {
    id,
    folderId: 'f1',
    accountId: 'a1',
    uid,
    messageId: `<${uid}>`,
    from: `Sender ${uid} <s${uid}@example.com>`,
    to: 'me@example.com',
    subject,
    snippet: '',
    date,
    isRead: true,
    isStarred: false,
    flagColor: null,
    hasAttachments: false,
    threadId: null
  }
}

const ROWS = [
  summaryRow('m1', 1, 3000, 'One'),
  summaryRow('m2', 2, 2000, 'Two'),
  summaryRow('m3', 3, 1000, 'Three')
]

// Conversation rows, for the threaded view. Each is a one-message thread here —
// enough to exercise selection and bulk actions without modelling replies.
function threadRow(threadId, date, subject) {
  return {
    threadId,
    accountId: 'a1',
    latestMessageId: `${threadId}-m`,
    from: 'Sender <s@example.com>',
    subject,
    snippet: '',
    date,
    isStarred: false,
    flagColor: null,
    hasAttachments: false,
    messageCount: 1,
    hasUnread: false,
    participants: ['Sender']
  }
}

const THREADS = [
  threadRow('t1', 5000, 'Thread one'),
  threadRow('t2', 4000, 'Thread two'),
  threadRow('t3', 3000, 'Thread three'),
  threadRow('t4', 2000, 'Thread four')
]

function threadMessage(threadId) {
  return {
    ...summaryRow(`${threadId}-m`, 90, 1000, `Message of ${threadId}`),
    threadId,
    cc: '',
    references: null,
    bodyHtml: null,
    bodyText: null,
    attachments: []
  }
}

// The stubbed IPC surface, standing in for the main process + SQLite.
const backend = {
  db: [...ROWS],
  threads: [...THREADS],
  pendingMove: null,
  deleteManyCalls: []
}

function installWindowStub() {
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
    orbitMail: {
      messages: {
        list: async () => [...backend.db],
        count: async () => backend.db.length,
        listThreads: async () => [...backend.threads],
        countThreads: async () => backend.threads.length,
        getThread: async (_accountId, threadId) => [threadMessage(threadId)],
        deleteMany: async (items) => {
          backend.deleteManyCalls.push(items)
          return { deleted: items.length, failed: 0 }
        },
        get: async (id) => {
          const row = backend.db.find((m) => m.id === id)
          if (!row) return null
          return { ...row, cc: '', references: null, bodyHtml: null, bodyText: null, attachments: [] }
        },
        // Held open so the test can decide when the "server" answers.
        move: (id) =>
          new Promise((resolve, reject) => {
            backend.pendingMove = { id, resolve, reject }
          }),
        delete: async () => {},
        markRead: async () => {}
      },
      folders: {
        list: async () => [
          { id: 'f1', accountId: 'a1', imapPath: 'INBOX', name: 'Inbox', type: 'inbox', unreadCount: 0, isVirtualView: false },
          { id: 'f2', accountId: 'a1', imapPath: 'Trash', name: 'Trash', type: 'trash', unreadCount: 0, isVirtualView: false }
        ]
      },
      preferences: { get: async () => ({}), saveUi: async () => {} },
      ai: { getCachedAnalysis: async () => null }
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function main() {
  await build({
    entryPoints: [join(root, 'src/stores/mailStore.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    logLevel: 'silent'
  })

  installWindowStub()
  const store = createRequire(import.meta.url)(outfile)
  const state = () => store.useMailStore.getState()

  // -------------------------------------------------------------------------
  section('Delete: a refresh mid-flight must not resurrect the row')
  // -------------------------------------------------------------------------
  state().setFolders(await window.orbitMail.folders.list())
  state().setSelectedFolderId('f1')
  state().setThreadedView(false)
  await store.refreshMessages()
  ok('the list starts with every row', state().messages.length === 3, `${state().messages.length} rows`)

  state().setSelectedMessageId('m2')
  const deleting = store.moveMessageToTrash('m2')
  await tick()
  ok('the row leaves the list immediately', !state().messages.some((m) => m.id === 'm2'))
  ok('the DB still holds it while the server op is in flight',
    backend.db.some((m) => m.id === 'm2'))

  // This is the race: a background refresh re-reads a DB that still has the row.
  await store.refreshMessages()
  ok('a refresh mid-delete does not bring the row back',
    !state().messages.some((m) => m.id === 'm2'),
    state().messages.map((m) => m.id).join(', '))
  ok('nor does it come back in the count', state().messageTotal === 2,
    `total=${state().messageTotal}`)

  // The server confirms; the main process has dropped the local row by the time
  // the IPC call resolves, so the hold can be released.
  backend.db = backend.db.filter((m) => m.id !== 'm2')
  backend.pendingMove.resolve()
  await deleting
  await store.refreshMessages()
  ok('it stays gone once the op has settled', !state().messages.some((m) => m.id === 'm2'))
  ok('the surviving rows are intact',
    state().messages.length === 2 && state().messageTotal === 2,
    `${state().messages.map((m) => m.id).join(', ')} total=${state().messageTotal}`)

  // -------------------------------------------------------------------------
  section('Delete: a rejected op releases the hold so the row returns')
  // -------------------------------------------------------------------------
  backend.db = [...ROWS]
  await store.refreshMessages()
  state().setSelectedMessageId('m3')
  const failing = store.moveMessageToTrash('m3')
  await tick()
  ok('the row leaves the list optimistically', !state().messages.some((m) => m.id === 'm3'))

  backend.pendingMove.reject(new Error('server said no'))
  await failing
  ok('the rollback refresh puts it back',
    state().messages.some((m) => m.id === 'm3'),
    state().messages.map((m) => m.id).join(', '))

  // -------------------------------------------------------------------------
  section('Delete: the selection advances to the next row down')
  // -------------------------------------------------------------------------
  backend.db = [...ROWS]
  await store.refreshMessages()
  state().setSelectedMessageId('m2')
  const advancing = store.moveMessageToTrash('m2')
  await tick()
  ok('the row below takes the selection', state().selectedMessageId === 'm3',
    `selected=${state().selectedMessageId}`)
  backend.db = backend.db.filter((m) => m.id !== 'm2')
  backend.pendingMove.resolve()
  await advancing

  state().setSelectedMessageId('m3')
  const advancingLast = store.moveMessageToTrash('m3')
  await tick()
  ok('deleting the last row falls back to the one above',
    state().selectedMessageId === 'm1', `selected=${state().selectedMessageId}`)
  backend.db = backend.db.filter((m) => m.id !== 'm3')
  backend.pendingMove.resolve()
  await advancingLast

  // -------------------------------------------------------------------------
  section('Conversation view: rows multi-select like flat rows')
  // -------------------------------------------------------------------------
  // Thread rows went straight to selectThread, so shift-click had nothing to
  // extend and bulk actions were impossible in the default (threaded) view.
  state().setThreadedView(true)
  await store.refreshMessages()
  ok('the thread list loaded', state().threads.length === 4, `${state().threads.length} rows`)

  await store.selectThread('a1', 't1')
  ok('a plain click selects one conversation',
    state().selectedThreadKeys.join(',') === 'a1 t1', state().selectedThreadKeys.join(','))

  store.selectThreadRange('a1', 't3')
  await tick()
  ok('shift-click selects the whole range',
    state().selectedThreadKeys.join(',') === 'a1 t1,a1 t2,a1 t3',
    state().selectedThreadKeys.join(','))
  ok('the clicked row leads the selection', state().selectedThreadId === 't3',
    String(state().selectedThreadId))

  store.selectThreadRange('a1', 't1')
  await tick()
  ok('dragging the range back up shrinks it',
    state().selectedThreadKeys.join(',') === 'a1 t1', state().selectedThreadKeys.join(','))

  await store.selectThread('a1', 't1')
  store.toggleThreadSelection('a1', 't3')
  await tick()
  ok('ctrl-click adds a non-adjacent conversation',
    state().selectedThreadKeys.join(',') === 'a1 t1,a1 t3', state().selectedThreadKeys.join(','))
  store.toggleThreadSelection('a1', 't3')
  await tick()
  ok('ctrl-clicking it again removes it',
    state().selectedThreadKeys.join(',') === 'a1 t1', state().selectedThreadKeys.join(','))

  // -------------------------------------------------------------------------
  section('Conversation view: Delete acts on every selected conversation')
  // -------------------------------------------------------------------------
  await store.selectThread('a1', 't1')
  store.selectThreadRange('a1', 't3')
  await tick()
  backend.deleteManyCalls = []
  await store.deleteSelectedThreads()
  ok('one batched delete call covers the selection',
    backend.deleteManyCalls.length === 1 && backend.deleteManyCalls[0].length === 3,
    `${backend.deleteManyCalls.length} call(s), ${backend.deleteManyCalls[0]?.length} item(s)`)
  ok('every selected row leaves the list',
    state().threads.map((t) => t.threadId).join(',') === 't4',
    state().threads.map((t) => t.threadId).join(','))
  // The survivor is selected exactly as a plain click would leave it — one key,
  // not the stale run and not an empty selection with a populated reader.
  ok('the selection is exactly the survivor',
    state().selectedThreadKeys.join(',') === 'a1 t4', state().selectedThreadKeys.join(','))
  ok('the survivor takes the selection', state().selectedThreadId === 't4',
    String(state().selectedThreadId))

  // A single-row selection still goes through the plain single-thread delete.
  backend.deleteManyCalls = []
  await store.selectThread('a1', 't4')
  await store.deleteSelectedThreads()
  ok('a lone selection deletes just that conversation',
    backend.deleteManyCalls.length === 1 && backend.deleteManyCalls[0].length === 1,
    `${backend.deleteManyCalls[0]?.length} item(s)`)

  console.log(
    `\n${failures === 0 ? 'all store checks passed' : `${failures} store check(s) FAILED`}`
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
