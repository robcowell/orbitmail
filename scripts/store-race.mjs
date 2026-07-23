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

// How many messages a conversation holds is configurable: the bulk-action
// checks want one apiece, the rollback checks want a conversation whose
// aggregate star/unread state can differ from a single message's.
function threadMessages(threadId) {
  return Array.from({ length: backend.messagesPerThread }, (_, i) => ({
    ...summaryRow(`${threadId}-m${i + 1}`, 90 + i, 1000 + i, `Message ${i + 1} of ${threadId}`),
    threadId,
    cc: '',
    references: null,
    bodyHtml: null,
    bodyText: null,
    attachments: []
  }))
}

// The stubbed IPC surface, standing in for the main process + SQLite.
const backend = {
  db: [...ROWS],
  threads: [...THREADS],
  pendingMove: null,
  deleteManyCalls: [],
  moveManyCalls: [],
  messagesPerThread: 1,
  // Make the reader's two fetches reject, to exercise the failure paths.
  getThreadFails: false,
  // One-shot gate: the *next* getThread parks until released, so a test can
  // interleave a click with an in-flight mutation. One-shot matters — the click
  // itself calls getThread, and it must not park behind the same gate.
  gateNextGetThread: false,
  releaseGetThread: null,
  getFails: false,
  // Flipped on to make the server reject the next flag/star write.
  writesFail: false,
  // Preference saves, and a gate for holding one open mid-flight.
  savedUi: [],
  completedSaves: 0,
  holdSaveUi: false,
  releaseSaveUi: null
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
        getThread: async (_accountId, threadId) => {
          if (backend.getThreadFails) throw new Error('thread fetch failed')
          if (backend.gateNextGetThread) {
            backend.gateNextGetThread = false
            await new Promise((resolve) => {
              backend.releaseGetThread = resolve
            })
          }
          return threadMessages(threadId)
        },
        toggleStar: async () => {
          if (backend.writesFail) throw new Error('server rejected the star')
        },
        setFlag: async () => {
          if (backend.writesFail) throw new Error('server rejected the flag')
        },
        deleteMany: async (items) => {
          backend.deleteManyCalls.push(items)
          return { deleted: items.length, failed: 0 }
        },
        moveMany: async (items) => {
          backend.moveManyCalls.push(items)
          return { deleted: items.length, failed: 0 }
        },
        get: async (id) => {
          if (backend.getFails) throw new Error('message fetch failed')
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
          { id: 'f2', accountId: 'a1', imapPath: 'Trash', name: 'Trash', type: 'trash', unreadCount: 0, isVirtualView: false },
          { id: 'f3', accountId: 'a1', imapPath: 'Archive', name: 'Archive', type: 'custom', unreadCount: 0, isVirtualView: false },
          { id: 'f4', accountId: 'a1', imapPath: 'Projects', name: 'Projects', type: 'custom', unreadCount: 0, isVirtualView: false }
        ]
      },
      preferences: {
        get: async () => ({}),
        saveUi: async (ui) => {
          backend.savedUi.push(ui)
          if (backend.holdSaveUi) await new Promise((r) => { backend.releaseSaveUi = r })
          backend.completedSaves++
          return ui
        }
      },
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

  await build({
    entryPoints: [join(root, 'src/stores/persistence.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'persistence.cjs'),
    logLevel: 'silent'
  })

  installWindowStub()
  const require = createRequire(import.meta.url)
  const store = require(outfile)
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

  // -------------------------------------------------------------------------
  section('Conversation view: archive and move act on the selection too')
  // -------------------------------------------------------------------------
  backend.threads = [...THREADS]
  await store.refreshMessages()
  await store.selectThread('a1', 't1')
  store.selectThreadRange('a1', 't3')
  await tick()
  backend.moveManyCalls = []
  await store.archiveSelectedThreads()
  ok('archive batches the selection into one moveMany',
    backend.moveManyCalls.length === 1 && backend.moveManyCalls[0].length === 3,
    `${backend.moveManyCalls.length} call(s), ${backend.moveManyCalls[0]?.length} item(s)`)
  ok('every message is aimed at the archive folder',
    backend.moveManyCalls[0]?.every((i) => i.targetFolderId === 'f3'),
    JSON.stringify(backend.moveManyCalls[0]))
  ok('archive does not go through the delete channel', backend.deleteManyCalls.length === 1)
  ok('the archived rows leave the list',
    state().threads.map((t) => t.threadId).join(',') === 't4',
    state().threads.map((t) => t.threadId).join(','))

  backend.threads = [...THREADS]
  await store.refreshMessages()
  await store.selectThread('a1', 't2')
  store.selectThreadRange('a1', 't4')
  await tick()
  backend.moveManyCalls = []
  await store.moveSelectedThreadsToFolder('f4')
  ok('move batches the selection into one moveMany',
    backend.moveManyCalls.length === 1 && backend.moveManyCalls[0].length === 3,
    `${backend.moveManyCalls[0]?.length} item(s)`)
  ok('every message is aimed at the chosen folder',
    backend.moveManyCalls[0]?.every((i) => i.targetFolderId === 'f4'),
    JSON.stringify(backend.moveManyCalls[0]))
  ok('the moved rows leave the list',
    state().threads.map((t) => t.threadId).join(',') === 't1',
    state().threads.map((t) => t.threadId).join(','))

  // -------------------------------------------------------------------------
  section('Flat list: archive and move act on a multi-selection')
  // -------------------------------------------------------------------------
  state().setThreadedView(false)
  backend.db = [...ROWS]
  await store.refreshMessages()
  state().setSelectedMessageIds(['m1', 'm2'])
  state().setSelectedMessageId('m1')
  backend.moveManyCalls = []
  await store.archiveSelectedMessages()
  ok('both selected messages are archived in one call',
    backend.moveManyCalls.length === 1 && backend.moveManyCalls[0].length === 2,
    `${backend.moveManyCalls[0]?.length} item(s)`)
  ok('they leave the list',
    state().messages.map((m) => m.id).join(',') === 'm3',
    state().messages.map((m) => m.id).join(','))

  backend.db = [...ROWS]
  await store.refreshMessages()
  state().setSelectedMessageIds(['m2', 'm3'])
  state().setSelectedMessageId('m2')
  backend.moveManyCalls = []
  await store.moveSelectedMessagesToFolder('f4')
  ok('a multi-selection moves in one call, aimed at the folder',
    backend.moveManyCalls.length === 1 &&
      backend.moveManyCalls[0].length === 2 &&
      backend.moveManyCalls[0].every((i) => i.targetFolderId === 'f4'),
    JSON.stringify(backend.moveManyCalls[0]))

  // Messages already in the destination are skipped rather than round-tripped.
  backend.db = [...ROWS]
  await store.refreshMessages()
  state().setSelectedMessageIds(['m1', 'm2'])
  state().setSelectedMessageId('m1')
  backend.moveManyCalls = []
  await store.moveSelectedMessagesToFolder('f1')
  ok('moving to the folder they are already in does nothing',
    backend.moveManyCalls.length === 0 && state().messages.length === 3,
    `${backend.moveManyCalls.length} call(s), ${state().messages.length} rows`)

  // -------------------------------------------------------------------------
  section('Conversation view: a rejected star rolls back')
  // -------------------------------------------------------------------------
  // patchMessageInList only knew about the flat list, the search results and the
  // single-message reader. In conversation view — the default — `messages` is
  // empty and the row lives in the open conversation, so the patch did nothing
  // and returned null, which meant the caller's rollback never ran: a star the
  // server refused stayed lit until the next refresh.
  state().setThreadedView(true)
  backend.threads = [...THREADS]
  backend.messagesPerThread = 2
  await store.refreshMessages()
  await store.selectThread('a1', 't1')
  const openThread = () => state().selectedThread ?? []
  const threadRow = (id) => state().threads.find((t) => t.threadId === id)
  ok('the conversation is open with both messages', openThread().length === 2,
    `${openThread().length} message(s)`)
  ok('it starts unstarred', !threadRow('t1')?.isStarred)

  backend.writesFail = false
  await store.toggleMessageStar('t1-m1', true)
  ok('starring a message in the open conversation shows immediately',
    openThread().find((m) => m.id === 't1-m1')?.isStarred === true)
  ok('the collapsed row picks up the star', threadRow('t1')?.isStarred === true)

  backend.writesFail = true
  await store.toggleMessageStar('t1-m1', false)
  ok('a rejected unstar rolls back on the message',
    openThread().find((m) => m.id === 't1-m1')?.isStarred === true,
    String(openThread().find((m) => m.id === 't1-m1')?.isStarred))
  ok('and rolls back on the collapsed row too', threadRow('t1')?.isStarred === true,
    String(threadRow('t1')?.isStarred))

  // -------------------------------------------------------------------------
  section('Inline-expanded conversation: the same rollback applies')
  // -------------------------------------------------------------------------
  backend.writesFail = false
  await store.toggleThreadExpanded('a1', 't2')
  await tick()
  const expanded = () => state().expandedThreadMessages['a1 t2'] ?? []
  ok('the expanded children are cached', expanded().length === 2, `${expanded().length}`)

  await store.toggleMessageStar('t2-m1', true)
  ok('starring an expanded child shows immediately',
    expanded().find((m) => m.id === 't2-m1')?.isStarred === true)
  ok('its conversation row picks up the star', threadRow('t2')?.isStarred === true)

  backend.writesFail = true
  await store.toggleMessageStar('t2-m1', false)
  ok('a rejected write rolls the expanded child back',
    expanded().find((m) => m.id === 't2-m1')?.isStarred === true,
    String(expanded().find((m) => m.id === 't2-m1')?.isStarred))
  ok('and rolls the conversation row back', threadRow('t2')?.isStarred === true)
  backend.writesFail = false
  backend.messagesPerThread = 1

  // -------------------------------------------------------------------------
  section('Flat list: rollback still works as before')
  // -------------------------------------------------------------------------
  state().setThreadedView(false)
  backend.db = [...ROWS]
  await store.refreshMessages()
  const row = (id) => state().messages.find((m) => m.id === id)
  await store.toggleMessageStar('m1', true)
  ok('the flat row stars optimistically', row('m1')?.isStarred === true)
  backend.writesFail = true
  await store.toggleMessageStar('m1', false)
  ok('and a rejected write restores it', row('m1')?.isStarred === true,
    String(row('m1')?.isStarred))
  backend.writesFail = false

  // -------------------------------------------------------------------------
  section('Reader: a failed open reports itself and can be retried')
  // -------------------------------------------------------------------------
  // Both opens awaited an IPC call with no catch, and callers invoke them as
  // `void selectThread(...)`. A rejection left threadLoading/readerLoading true,
  // so the pane sat on "Loading conversation…" forever with nothing said.
  state().setThreadedView(true)
  backend.threads = [...THREADS]
  await store.refreshMessages()

  backend.getThreadFails = true
  await store.selectThread('a1', 't1')
  ok('a failed conversation open stops loading',
    state().threadLoading === false, `threadLoading=${state().threadLoading}`)
  ok('it records why, for the reader to show',
    state().readerError?.message === 'thread fetch failed', state().readerError?.message)
  ok('it remembers what to retry',
    state().readerError?.retry?.kind === 'thread' &&
      state().readerError?.retry?.threadId === 't1',
    JSON.stringify(state().readerError?.retry))
  ok('the row stays selected so the user has not lost their place',
    state().selectedThreadId === 't1', String(state().selectedThreadId))

  backend.getThreadFails = false
  await store.retryReaderLoad()
  ok('retrying clears the error', state().readerError === null)
  ok('and the conversation opens', (state().selectedThread ?? []).length > 0,
    `${(state().selectedThread ?? []).length} message(s)`)

  // A single message open fails the same way.
  state().setThreadedView(false)
  backend.db = [...ROWS]
  await store.refreshMessages()
  backend.getFails = true
  await store.selectMessage('m2')
  ok('a failed message open stops loading',
    state().readerLoading === false, `readerLoading=${state().readerLoading}`)
  ok('it records the message to retry',
    state().readerError?.retry?.kind === 'message' &&
      state().readerError?.retry?.messageId === 'm2',
    JSON.stringify(state().readerError?.retry))

  backend.getFails = false
  await store.retryReaderLoad()
  ok('retrying opens the message', state().selectedMessage?.id === 'm2' && !state().readerError,
    `${state().selectedMessage?.id} error=${state().readerError?.message ?? 'none'}`)

  // A stale error must not outlive the thing it was about.
  backend.getFails = true
  await store.selectMessage('m3')
  ok('the error is set again', !!state().readerError)
  backend.getFails = false
  await store.selectMessage('m1')
  ok('selecting something else clears it', state().readerError === null)

  // -------------------------------------------------------------------------
  section('Thread mutations: the selection is judged when they land, not when they start')
  // -------------------------------------------------------------------------
  // A thread mutation resolves its messages over IPC before touching the list,
  // and the user can click during that gap. Deciding whether to clear the reader
  // from a snapshot taken *before* the await gets it wrong in both directions:
  // it can leave a deleted conversation on screen, or clear one the user has
  // since opened.
  state().setThreadedView(true)
  backend.threads = [...THREADS]
  backend.messagesPerThread = 1
  await store.refreshMessages()
  await store.selectThread('a1', 't1')
  ok('t1 is open to begin with', state().selectedThreadId === 't1')

  // Delete t2 — not the open conversation, so it awaits getThread — and click
  // t2 while that is in flight. By the time the delete lands, t2 *is* the open
  // conversation, so the reader must be cleared.
  backend.gateNextGetThread = true
  const deletingT2 = store.deleteThread('a1', 't2')
  await tick()
  await store.selectThread('a1', 't2')
  ok('the user has opened t2 mid-flight', state().selectedThreadId === 't2')
  backend.releaseGetThread?.()
  await deletingT2
  ok('the deleted conversation does not stay on screen',
    state().selectedThreadId !== 't2', `selected=${state().selectedThreadId}`)
  ok('and its row is gone from the list',
    !state().threads.some((t) => t.threadId === 't2'),
    state().threads.map((t) => t.threadId).join(','))

  // The other direction: delete the open conversation, but move to another one
  // before it lands. The reader must keep what the user chose.
  backend.threads = [...THREADS]
  await store.refreshMessages()
  await store.selectThread('a1', 't3')
  backend.gateNextGetThread = true
  const deletingT4 = store.deleteThread('a1', 't4')
  await tick()
  await store.selectThread('a1', 't1')
  backend.releaseGetThread?.()
  await deletingT4
  ok('a delete that lands late does not steal the reader',
    state().selectedThreadId === 't1', `selected=${state().selectedThreadId}`)

  // -------------------------------------------------------------------------
  section('Preferences: the quit flush can be waited on')
  // -------------------------------------------------------------------------
  // Quit calls window.__orbitMailFlush and waits for what it returns. That only
  // means anything if the flush resolves when the write has *happened* — it used
  // to fire the IPC and return immediately, so the last change before quit was
  // routinely lost.
  const persistence = require(join(outDir, 'persistence.cjs'))
  persistence.exposeFlushHook()
  ok('the flush hook is exposed for main to call', typeof window.__orbitMailFlush === 'function')

  backend.holdSaveUi = true
  backend.completedSaves = 0
  const flushing = window.__orbitMailFlush()
  ok('it returns something awaitable', typeof flushing?.then === 'function')

  let settled = false
  void flushing.then(() => { settled = true })
  await tick()
  ok('it has not resolved while the write is in flight', settled === false)

  backend.releaseSaveUi?.()
  await flushing
  ok('it resolves once the write completes', backend.completedSaves === 1,
    `${backend.completedSaves} completed`)
  backend.holdSaveUi = false

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
