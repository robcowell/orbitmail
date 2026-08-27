// Renderer regression tests, run under plain node.
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
//
// The same harness suits any pure renderer logic that would otherwise need a
// GUI to exercise — see the recipient-autocomplete section at the end.

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
  releaseSaveUi: null,
  // Global settings: what the stored blob looks like, what was written, and
  // whether the write (or the OS-level mailto registration) succeeds.
  persistedState: {},
  savedPreferences: [],
  preferenceSaveFails: false,
  mailtoRegistrationSucceeds: true,
  capabilities: { trayActive: true, notificationsSupported: true, mailtoHandlerActive: false }
}

function installWindowStub() {
  // Enough DOM for applyTheme, which stamps the theme onto the root element.
  // Loading persisted preferences applies dark mode, so this is unavoidable
  // once the settings tests exercise that path.
  globalThis.document = { documentElement: { dataset: {} } }
  globalThis.localStorage = {
    store: new Map(),
    getItem(key) {
      return this.store.has(key) ? this.store.get(key) : null
    },
    setItem(key, value) {
      this.store.set(key, String(value))
    }
  }
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
        // Deliberately the shape an install predating the settings screen has:
        // no `ui`, none of the global keys. loadPersistedPreferences has to
        // cope, because that blob exists on every machine running an old build.
        get: async () => backend.persistedState,
        saveUi: async (ui) => {
          backend.savedUi.push(ui)
          if (backend.holdSaveUi) await new Promise((r) => { backend.releaseSaveUi = r })
          backend.completedSaves++
          return ui
        },
        save: async (patch) => {
          if (backend.preferenceSaveFails) throw new Error('disk is full')
          backend.savedPreferences.push(patch)
          return patch
        },
        setHandleMailtoLinks: async (enabled) => {
          if (backend.preferenceSaveFails) throw new Error('disk is full')
          backend.savedPreferences.push({ handleMailtoLinks: enabled })
          // The OS gets the last word; the harness can make it disagree.
          return backend.mailtoRegistrationSucceeds ? enabled : false
        }
      },
      app: {
        getPlatformCapabilities: async () => backend.capabilities
      },
      // Both cached-only reads, because selectMessage and selectThread each fire
      // one on open. A missing stub here is not a missing assertion — it throws
      // inside every test that opens a message or a thread.
      ai: {
        getCachedAnalysis: async () => null,
        getCachedThreadAnalysis: async () => null
      }
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

  // mailStore and persistence bundled together, so they share one module
  // instance. Bundling them separately gives each its own copy of the Zustand
  // store, and a preference loaded through one is invisible to the other — the
  // assertions then read untouched defaults and pass no matter what.
  await build({
    stdin: {
      contents: [
        "export * from './mailStore'",
        "export { loadPersistedPreferences } from './persistence'"
      ].join('\n'),
      resolveDir: join(root, 'src/stores'),
      loader: 'ts'
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'settings.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/utils/composeBody.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'composeBody.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/components/settings/AccountsPane.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'accountsPane.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/components/reader/RemoteContentBar.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'remoteContent.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/components/compose/RecipientInput.tsx')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'recipientInput.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/utils/folders.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'folders.cjs'),
    logLevel: 'silent'
  })

  // Reachable here only because the classifier is deliberately string work and
  // not a DOM walk: this script runs in plain node, where there is no DOM at
  // all (DOMPurify itself could not run).
  await build({
    entryPoints: [join(root, 'src/utils/emailColorScheme.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'emailColorScheme.cjs'),
    logLevel: 'silent'
  })

  // The status-bar wording is a pure function for exactly this reason: the bug
  // it replaces lived in JSX, where no test in this repo could reach it.
  // Search scope is pure: which account (or all of them) a query runs against,
  // and how a cross-account result names its folder.
  await build({
    entryPoints: [join(root, 'src/utils/search.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'search.cjs'),
    logLevel: 'silent'
  })

  await build({
    entryPoints: [join(root, 'src/utils/syncStatus.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'syncStatus.cjs'),
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

  // -------------------------------------------------------------------------
  section('Settings: globals are optimistic, and defaults survive an old blob')
  // -------------------------------------------------------------------------
  {
    // This bundle carries its own store instance (see the build above), so every
    // assertion here reads through `settings`, not the outer `state()`.
    const settings = require(join(outDir, 'settings.cjs'))
    const pref = () => settings.useMailStore.getState()

    backend.persistedState = {}
    await settings.loadPersistedPreferences()
    ok('a blob with no settings keys loads without throwing', true)
    ok('close-to-tray defaults on', pref().closeToTray === true, String(pref().closeToTray))
    ok('notifications default on',
      pref().desktopNotifications === true, String(pref().desktopNotifications))
    ok('remote images default to blocked — the private default is the absent one',
      pref().alwaysLoadRemoteImages === false, String(pref().alwaysLoadRemoteImages))

    // An explicitly-off blob must not be read as "absent, so on".
    backend.persistedState = { ui: {}, closeToTray: false, alwaysLoadRemoteImages: true }
    await settings.loadPersistedPreferences()
    ok('an explicit false is not mistaken for an absent key',
      pref().closeToTray === false && pref().alwaysLoadRemoteImages === true,
      `tray=${pref().closeToTray} images=${pref().alwaysLoadRemoteImages}`)

    // Toggling is optimistic and sends only the key that changed — a whole-blob
    // save would race the debounced UI write.
    backend.savedPreferences = []
    await settings.setGlobalPreference('desktopNotifications', false)
    ok('the toggle applies immediately', pref().desktopNotifications === false)
    ok('and only the changed key is sent',
      backend.savedPreferences.length === 1 &&
        JSON.stringify(backend.savedPreferences[0]) === '{"desktopNotifications":false}',
      JSON.stringify(backend.savedPreferences))

    // A rejected write must not leave the UI claiming a setting that did not
    // stick — the same contract the message actions have.
    backend.preferenceSaveFails = true
    await settings.setGlobalPreference('desktopNotifications', true)
    ok('a failed save rolls the toggle back',
      pref().desktopNotifications === false, String(pref().desktopNotifications))
    ok('and says so', !!pref().toast, pref().toast ?? 'no toast')
    backend.preferenceSaveFails = false

    // mailto is the one where the OS overrules us: on Linux the registration
    // needs an installed .desktop file, so a dev build cannot take it.
    backend.mailtoRegistrationSucceeds = false
    pref().setToast(null)
    await settings.setGlobalPreference('handleMailtoLinks', true)
    ok('a mailto registration the OS refused does not show as on',
      pref().handleMailtoLinks === false, String(pref().handleMailtoLinks))
    ok('and explains why', !!pref().toast, pref().toast ?? 'no toast')
    backend.mailtoRegistrationSucceeds = true

    // Opening settings aims the dialog, and closing clears the account it was
    // aimed at so the next open does not land on a stale one.
    settings.openSettings('accounts', 'acct-7')
    ok('openSettings opens on the category asked for',
      pref().showSettings && pref().settingsCategory === 'accounts',
      `${pref().showSettings}/${pref().settingsCategory}`)
    ok('and remembers which account it was aimed at', pref().settingsAccountId === 'acct-7')
    await tick()
    ok('it asks what this desktop supports, so a toggle cannot lie',
      pref().platformCapabilities?.trayActive === true,
      JSON.stringify(pref().platformCapabilities))
    pref().setShowSettings(false)
    ok('closing clears the aimed-at account', pref().settingsAccountId === null)

    // Whether a tracking pixel fires is not a decision to leave to a manual
    // click-through, so the predicate behind it is exported and asserted here.
    const { isRemoteContentBlocked } = require(join(outDir, 'remoteContent.cjs'))
    const base = {
      alwaysLoad: false,
      allowed: [],
      senderEmail: 'news@stripe.com',
      loadedThisSession: false,
      hasRemote: true
    }
    ok('remote content is blocked by default', isRemoteContentBlocked(base) === true)
    ok('a message with no remote content is never "blocked"',
      isRemoteContentBlocked({ ...base, hasRemote: false }) === false)
    ok('the global setting unblocks every sender',
      isRemoteContentBlocked({ ...base, alwaysLoad: true }) === false)
    ok('an allowlisted sender unblocks without the global',
      isRemoteContentBlocked({ ...base, allowed: ['news@stripe.com'] }) === false)
    ok('a different allowlisted sender does not unblock this one',
      isRemoteContentBlocked({ ...base, allowed: ['someone@else.com'] }) === true)
    ok('loading once this session unblocks that message',
      isRemoteContentBlocked({ ...base, loadedThisSession: true }) === false)

    // Which account the Accounts pane shows. The failure this prevents is
    // invisible until it happens: remove the selected account and the pane is
    // left pointing at an id that no longer exists, rendering nothing.
    const { resolveSelectedAccountId } = require(join(outDir, 'accountsPane.cjs'))
    const three = [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }]
    ok('with nothing chosen it shows the first account',
      resolveSelectedAccountId(three, null, null) === 'a1')
    ok('opening Settings for an account shows that one',
      resolveSelectedAccountId(three, 'a3', 'a1') === 'a3')
    ok('an existing selection is kept when nothing is aimed at',
      resolveSelectedAccountId(three, null, 'a2') === 'a2')
    ok('removing the selected account falls back rather than showing nothing',
      resolveSelectedAccountId([{ id: 'a1' }, { id: 'a3' }], null, 'a2') === 'a1')
    ok('an aimed-at account that no longer exists does not win',
      resolveSelectedAccountId(three, 'gone', 'a2') === 'a2')
    ok('with no accounts at all it resolves to nothing',
      resolveSelectedAccountId([], 'a1', 'a2') === null)

    // What actually goes out when the quoted original has been trimmed or
    // dropped. The body and the quote are separate the whole time they are
    // being edited and only combined here, which is why removing the quote
    // needs no other change.
    const { joinBodyWithQuote } = require(join(outDir, 'composeBody.cjs'))
    const quote = { html: '<blockquote>On Tue, Roger wrote:</blockquote>', text: '> hello' }

    const withQuote = joinBodyWithQuote('<p>Yes</p>', 'Yes', quote)
    ok('the quote is appended after what was written',
      withQuote.bodyHtml === '<p>Yes</p><br><br><blockquote>On Tue, Roger wrote:</blockquote>',
      withQuote.bodyHtml)
    ok('and the plain-text part is joined too',
      withQuote.bodyText === 'Yes\n\n> hello', JSON.stringify(withQuote.bodyText))

    const removed = joinBodyWithQuote('<p>Yes</p>', 'Yes', null)
    ok('removing the quote sends the message without it',
      removed.bodyHtml === '<p>Yes</p>' && removed.bodyText === 'Yes',
      removed.bodyHtml)

    const trimmed = joinBodyWithQuote('<p>Yes</p>', 'Yes', {
      html: '<blockquote>just the relevant line</blockquote>',
      text: '> just the relevant line'
    })
    ok('a trimmed quote sends exactly what is left of it',
      trimmed.bodyHtml.includes('just the relevant line') &&
        !trimmed.bodyHtml.includes('On Tue'),
      trimmed.bodyHtml)

    // Deleting every line out of the quote should send as though it were
    // removed, not leave a pair of <br>s and a blank gap.
    const emptied = joinBodyWithQuote('<p>Yes</p>', 'Yes', { html: '<br>', text: '  ' })
    ok('a quote emptied line by line is treated as removed',
      emptied.bodyHtml === '<p>Yes</p>', emptied.bodyHtml)

    // But a quote holding only an image has no text and is still real content.
    const imageOnly = joinBodyWithQuote('<p>Yes</p>', 'Yes', {
      html: '<blockquote><img src="cid:x"></blockquote>',
      text: ''
    })
    ok('a quote that is only an image is still sent',
      imageOnly.bodyHtml.includes('<img'), imageOnly.bodyHtml)
  }

  // -------------------------------------------------------------------------
  section('Recipient autocomplete: only the address under the caret is rewritten')
  // -------------------------------------------------------------------------
  {
    // The To/Cc/Bcc fields stay a plain comma-separated string, so accepting a
    // suggestion is string surgery on one token. Getting the bounds wrong eats
    // an address the user already typed, which they would only notice after
    // sending — worth pinning down without a GUI.
    const { activeToken, applySuggestion } = require(join(outDir, 'recipientInput.cjs'))
    const contact = (address, name = null) => ({ address, name, sentCount: 3, seenCount: 1 })

    ok('the token is the address the caret sits in',
      activeToken('alice@x.com, rob', 16).text === 'rob',
      activeToken('alice@x.com, rob', 16).text)
    ok('a caret back inside an earlier address selects that one',
      activeToken('alice@x.com, rob', 5).text === 'alice@x.com',
      activeToken('alice@x.com, rob', 5).text)
    // A display name may legitimately contain a comma.
    ok('a comma inside a quoted display name does not split the list',
      activeToken('"Doe, Jane" <j@x.com>, rob', 25).text === 'rob',
      activeToken('"Doe, Jane" <j@x.com>, rob', 25).text)

    const completed = applySuggestion('alice@x.com, rob', 16, contact('robin@acme.co', 'Robin Hayes'))
    ok('accepting keeps the addresses already entered',
      completed.value === 'alice@x.com, Robin Hayes <robin@acme.co>, ',
      JSON.stringify(completed.value))
    ok('and leaves the caret ready for the next address',
      completed.caret === 'alice@x.com, Robin Hayes <robin@acme.co>'.length + 2,
      String(completed.caret))

    const middle = applySuggestion('rob, carol@x.com', 3, contact('robin@acme.co', 'Robin Hayes'))
    ok('completing an address mid-list does not disturb what follows',
      middle.value === 'Robin Hayes <robin@acme.co>, carol@x.com',
      JSON.stringify(middle.value))

    const commaName = applySuggestion('', 0, contact('j@x.com', 'Doe, Jane'))
    ok('a display name containing a comma is quoted, so the list still parses',
      commaName.value.startsWith('"Doe, Jane" <j@x.com>'),
      JSON.stringify(commaName.value))

    const bare = applySuggestion('ro', 2, contact('rob@x.com'))
    ok('a contact with no display name inserts the bare address',
      bare.value === 'rob@x.com, ', JSON.stringify(bare.value))
  }

  // -------------------------------------------------------------------------
  section('Dark mode: mail written for a white page gets one')
  // -------------------------------------------------------------------------
  {
    const { assumesLightBackground } = require(join(outDir, 'emailColorScheme.cjs'))

    // The two shapes that were actually reported as unreadable.
    ok('dark text with no background asks for a light page',
      assumesLightBackground('<div style="color:#1a1a1a">Hello</div>'))
    ok('a white background with no text colour asks for one too',
      assumesLightBackground('<table bgcolor="#ffffff"><tr><td>Hello</td></tr></table>'))

    // The whole point of classifying rather than always papering: mail that
    // sets nothing, and mail that brought its own dark theme, must stay dark.
    ok('mail that sets no colour at all is left on the theme',
      !assumesLightBackground('<div><p>Hello</p><em>and again</em></div>'))
    ok('a dark background with light text is left alone',
      !assumesLightBackground('<td style="background-color:#101014;color:#ffffff">Hi</td>'))
    ok('light text on its own is left alone — it is already readable on dark',
      !assumesLightBackground('<div style="color:#ffffff">Hi</div>'))

    // `background-color` contains the string `color`, so a substring search
    // would read a dark background as dark *text* and paper the message —
    // exactly backwards. Properties are compared whole for this reason.
    ok('a dark background is not mistaken for dark text',
      !assumesLightBackground('<div style="background-color:#000000">Hi</div>'))

    // Colours that paint nothing imply nothing about the page.
    ok('transparent is not a light background',
      !assumesLightBackground('<div style="background:transparent">Hi</div>'))
    ok('a fully transparent rgba is not a light background',
      !assumesLightBackground('<div style="background:rgba(255,255,255,0)">Hi</div>'))
    ok('a background image with no colour is not a light background',
      !assumesLightBackground('<div style="background:url(cid:x) no-repeat">Hi</div>'))

    // The formats real mail actually uses.
    ok('a three-digit hex is read', assumesLightBackground('<p style="color:#333">Hi</p>'))
    ok('rgb() is read', assumesLightBackground('<p style="color:rgb(20, 20, 20)">Hi</p>'))
    ok('a named colour is read', assumesLightBackground('<font color="black">Hi</font>'))
    ok('<font color> is read', assumesLightBackground('<font color="#222222">Hi</font>'))

    // `bgcolor=` ends in `color=`, so the <font color> pattern must not match
    // inside it. The case that discriminates is a *dark* bgcolor: read as a
    // background it is fine under our light text and nothing happens, but read
    // as text it looks unreadable and the message is papered for no reason.
    // A light bgcolor would not catch this — it is flagged either way.
    ok('a dark bgcolor is not read as dark text',
      !assumesLightBackground('<table bgcolor="#111111"><tr><td>Hi</td></tr></table>'))
    ok('a light bgcolor still asks for a page',
      assumesLightBackground('<table bgcolor="white"><tr><td>Hi</td></tr></table>'))

    // Judged against the dark theme's own surface at the AA bar rather than a
    // guess at what counts as "dark", which puts the boundary between #777
    // (3.6:1 on #1e1e24, fails) and #888 (4.6:1, passes). Both sides asserted,
    // because a threshold only tested from one side can be anywhere.
    ok('grey text that fails contrast on our dark surface asks for a page',
      assumesLightBackground('<p style="color:#777777">Hi</p>'))
    ok('grey text that passes contrast does not',
      !assumesLightBackground('<p style="color:#888888">Hi</p>'))
    ok('and light grey is comfortably left alone',
      !assumesLightBackground('<p style="color:#cccccc">Hi</p>'))

    ok('an empty body asks for nothing', !assumesLightBackground(''))
    ok('a null body asks for nothing', !assumesLightBackground(null))
  }

  // -------------------------------------------------------------------------
  section('Favourites: a row that needs qualifying, and one that does not')
  // -------------------------------------------------------------------------
  {
    const { favoriteRowHints, folderParentPath } = require(join(outDir, 'folders.cjs'))
    const names = new Map([['a1', 'Personal'], ['a2', 'Work']])
    const folder = (id, accountId, name, imapPath) => ({
      id, accountId, name, imapPath, type: 'custom', unreadCount: 0, isVirtualView: false
    })
    const hints = (rows) => favoriteRowHints(rows, names)

    // The delimiter is per-server and unstored; the leaf is the tail of the
    // path, so the character in front of it is the delimiter whatever it is.
    ok('a parent is read off a slash-delimited path',
      folderParentPath(folder('f', 'a1', 'Receipts', 'Work/Receipts')) === 'Work')
    ok('and off a dot-delimited one, with nothing told about the delimiter',
      folderParentPath(folder('f', 'a1', 'Receipts', 'Work.Receipts')) === 'Work')
    ok('a top-level folder has no parent',
      folderParentPath(folder('f', 'a1', 'Receipts', 'Receipts')) === undefined)
    // A localized or renamed name is not the tail of its path. Slicing by
    // length anyway would cut mid-path and print a fragment as if it were a
    // parent, which is worse than showing nothing.
    ok('a name that is not the tail of its path yields no parent',
      folderParentPath(folder('f', 'a1', 'Bin', '[Gmail]/Trash')) === undefined)

    ok('a unique name is not qualified at all',
      hints([
        folder('f1', 'a1', 'Receipts', 'Receipts'),
        folder('f2', 'a1', 'Travel', 'Travel')
      ]).size === 0)

    const crossAccount = hints([
      folder('f1', 'a1', 'Inbox', 'INBOX'),
      folder('f2', 'a2', 'Inbox', 'INBOX')
    ])
    ok('the same name in two accounts is qualified by account',
      crossAccount.get('f1') === 'Personal' && crossAccount.get('f2') === 'Work',
      [...crossAccount].map(([id, h]) => `${id}=${h}`).join(', '))

    // The case this section exists for: the account name is identical on both
    // rows, so it disambiguates nothing and the parent has to carry it.
    const sameAccount = hints([
      folder('f1', 'a1', 'Receipts', 'Work/Receipts'),
      folder('f2', 'a1', 'Receipts', 'Home/Receipts')
    ])
    ok('the same name twice in one account is qualified by parent, not account',
      sameAccount.get('f1') === 'Work' && sameAccount.get('f2') === 'Home',
      [...sameAccount].map(([id, h]) => `${id}=${h}`).join(', '))

    // Both kinds of collision at once. Only the account that holds two of them
    // needs a parent; the third row is told apart by its account alone, and
    // giving it a parent it does not need would be noise.
    const both = hints([
      folder('f1', 'a1', 'Receipts', 'Work/Receipts'),
      folder('f2', 'a1', 'Receipts', 'Home/Receipts'),
      folder('f3', 'a2', 'Receipts', 'Receipts')
    ])
    ok('a row colliding both ways names the account and the parent',
      both.get('f1') === 'Personal · Work' && both.get('f2') === 'Personal · Home',
      [...both].map(([id, h]) => `${id}=${h}`).join(', '))
    ok('while the row that only collides across accounts names just the account',
      both.get('f3') === 'Work', String(both.get('f3')))

    ok('case does not hide a collision',
      hints([
        folder('f1', 'a1', 'receipts', 'Work/receipts'),
        folder('f2', 'a1', 'Receipts', 'Home/Receipts')
      ]).size === 2)

    // Two top-level folders cannot both be named the same thing on one server,
    // so this is a corrupt or hand-made state rather than a real mailbox — it
    // must not throw, and must not print a bare separator.
    const noParent = hints([
      folder('f1', 'a1', 'Receipts', 'Receipts'),
      folder('f2', 'a1', 'Receipts', 'Receipts')
    ])
    ok('a same-account collision with no parent to show is left unqualified',
      noParent.size === 0)
  }

  // -------------------------------------------------------------------------
  section('Sync status: a failing account must not silence the healthy ones')
  // -------------------------------------------------------------------------
  {
    const { summarizeSyncStatus, syncErrorDetail } = require(join(outDir, 'syncStatus.cjs'))

    const acct = (id, email, over = {}) => ({
      accountId: id, email, syncing: false, lastSyncAt: null, error: null, ...over
    })
    const status = (accounts) => ({
      syncing: false, lastSyncAt: null, syncCurrent: 0, syncTotal: 0,
      accounts: Object.fromEntries(accounts.map((a) => [a.accountId, a]))
    })

    // The regression this exists for. Work is broken; Personal synced a moment
    // ago. The old status bar rendered its timestamp only when *nothing*
    // anywhere had errored, so Personal silently stopped reporting.
    const mixed = summarizeSyncStatus(status([
      acct('p', 'personal@example.com', { lastSyncAt: 5000 }),
      acct('w', 'work@example.com', { error: 'connect ECONNREFUSED' })
    ]))
    ok('a healthy account still reports its last sync while another fails',
      mixed.healthyLastSyncAt === 5000, `healthyLastSyncAt=${mixed.healthyLastSyncAt}`)
    ok('and the failing one is named in the summary line',
      mixed.errorLabel === 'work@example.com: connect ECONNREFUSED', mixed.errorLabel)
    ok('the wording changes when only some accounts are healthy', mixed.mixed === true)

    // A stale timestamp on a broken mailbox must not be presented as freshness.
    const staleWins = summarizeSyncStatus(status([
      acct('p', 'personal@example.com', { lastSyncAt: 1000 }),
      acct('w', 'work@example.com', { lastSyncAt: 9999, error: 'expired' })
    ]))
    ok('a failing account does not lend its timestamp to the healthy line',
      staleWins.healthyLastSyncAt === 1000, `healthyLastSyncAt=${staleWins.healthyLastSyncAt}`)

    // Several failures are counted, not concatenated. They used to be joined
    // with a blank line into one string and rendered in a one-line bar, where
    // HTML collapsed the break and produced a run-on sentence.
    const many = summarizeSyncStatus(status([
      acct('a', 'a@example.com', { error: 'no route to host' }),
      acct('b', 'b@example.com', { error: 'certificate expired' })
    ]))
    ok('two failures are counted rather than pasted together',
      many.errorLabel === '2 accounts are not syncing', many.errorLabel)
    ok('but the full detail survives for the tooltip, one line per account',
      syncErrorDetail(many.failing).split('\n').length === 2,
      JSON.stringify(syncErrorDetail(many.failing)))

    // Re-auth is offered for credential failures only; a dropped connection
    // must not send the user round an OAuth loop that fixes nothing.
    ok('an expired credential offers re-authentication',
      summarizeSyncStatus(status([acct('a', 'a@x', { error: 'invalid_grant' })])).needsReauth)
    ok('a network failure does not',
      !summarizeSyncStatus(status([acct('a', 'a@x', { error: 'no route to host' })])).needsReauth)

    const clean = summarizeSyncStatus(status([acct('p', 'p@x', { lastSyncAt: 42 })]))
    ok('with nothing wrong there is no error line and no mixed wording',
      clean.errorLabel === null && clean.mixed === false && clean.healthyLastSyncAt === 42)
    ok('an account list that is empty summarizes without throwing',
      summarizeSyncStatus(status([])).healthyLastSyncAt === null)
  }

  // -------------------------------------------------------------------------
  section('Connectivity: an outage is proved by failed connections, not a flag')
  // -------------------------------------------------------------------------
  {
    const { deriveConnectivity } = require(join(outDir, 'syncStatus.cjs'))

    const acct = (id, over = {}) => ({
      accountId: id, email: id + '@x', syncing: false,
      lastSyncAt: null, error: null, reachedServer: null, ...over
    })
    const status = (accounts, over = {}) => ({
      syncing: false, lastSyncAt: null, syncCurrent: 0, syncTotal: 0,
      accounts: Object.fromEntries(accounts.map((a) => [a.accountId, a])), ...over
    })

    // navigator.onLine is trusted only when it says no.
    ok('the OS reporting no network is taken at its word',
      deriveConnectivity(status([acct('a', { reachedServer: true })]), false).state === 'offline')

    // The case the old banner could never show: the OS says we are online and
    // nothing is actually reachable. A captive portal, a dropped VPN, DNS gone.
    const portal = deriveConnectivity(
      status([acct('a', { reachedServer: false, error: 'ECONNREFUSED' })]), true)
    ok('nothing reachable while the OS claims a network is an outage',
      portal.state === 'unreachable', portal.state)
    ok('and the wording says so rather than blaming the network',
      portal.message === "Can't reach your mail server — showing cached mail", portal.message)
    ok('the plural is used when more than one account has tried',
      deriveConnectivity(status([
        acct('a', { reachedServer: false }), acct('b', { reachedServer: false })
      ]), true).message === "Can't reach your mail servers — showing cached mail")

    // One account getting through proves the network works, so another's
    // failure is that account's problem and belongs on the account.
    ok('one reachable account means we are not offline',
      deriveConnectivity(status([
        acct('a', { reachedServer: true }),
        acct('b', { reachedServer: false, error: 'ECONNREFUSED' })
      ]), true).state === 'online')

    // Being refused is being reached. Claiming an outage here would send the
    // user to debug a working network instead of their expired credentials.
    ok('an account that was refused is not an outage',
      deriveConnectivity(status([
        acct('a', { reachedServer: true, error: 'Authentication failed: token expired' })
      ]), true).state === 'online')

    // Never claim an outage from silence.
    ok('no accounts at all says nothing',
      deriveConnectivity(status([]), true).state === 'online')
    ok('an account that has never been tried says nothing',
      deriveConnectivity(status([acct('a')]), true).state === 'online')
    ok('mid-sync says nothing — an account has not finished failing yet',
      deriveConnectivity(
        status([acct('a', { reachedServer: false })], { syncing: true }), true).state === 'online')
    ok('and there is no banner text when everything is fine',
      deriveConnectivity(status([acct('a', { reachedServer: true })]), true).message === null)
  }

  // -------------------------------------------------------------------------
  section('Search scope: the unified inbox is searchable')
  // -------------------------------------------------------------------------
  {
    const { resolveSearchScope, searchPlaceholder, searchFolderLabels } =
      require(join(outDir, 'search.cjs'))

    const accounts = [
      { id: 'a1', email: 'me@personal.example', displayName: 'Personal' },
      { id: 'a2', email: 'me@work.example', displayName: 'Work' }
    ]
    const folders = [
      { id: 'f1', accountId: 'a1', name: 'Inbox' },
      { id: 'f2', accountId: 'a2', name: 'Inbox' },
      { id: 'f3', accountId: 'a1', name: 'Receipts' }
    ]

    // The regression this exists for. "All Inboxes" is the view you land on,
    // and it was the one view whose search box was disabled.
    const unified = resolveSearchScope('unified', folders, accounts)
    ok('the unified inbox is searchable', unified.enabled === true)
    ok('and its scope is every account, not none',
      unified.accountId === null, String(unified.accountId))
    ok('the placeholder says so rather than telling you to pick a folder',
      searchPlaceholder(unified) === 'Search all accounts…', searchPlaceholder(unified))

    // With one account "all accounts" reads oddly, and the unified view exists
    // regardless of how many there are.
    const single = resolveSearchScope('unified', [folders[0]], [accounts[0]])
    ok('one account is named rather than called "all accounts"',
      searchPlaceholder(single) === 'Search Personal…', searchPlaceholder(single))

    // A folder still scopes to its own account.
    const scoped = resolveSearchScope('f2', folders, accounts)
    ok('a folder scopes the search to its account', scoped.accountId === 'a2', scoped.accountId)
    ok('and the placeholder names that account',
      searchPlaceholder(scoped) === 'Search Work…', searchPlaceholder(scoped))

    // null now means "everything", so an unresolvable folder must not be
    // silently promoted into a search across every account.
    const stale = resolveSearchScope('folder-that-went-away', folders, accounts)
    ok('an unknown folder is not searchable', stale.enabled === false)
    ok('and is not quietly promoted to searching everything',
      stale.accountId === null && stale.enabled === false)
    ok('no accounts at all is not searchable',
      resolveSearchScope('unified', [], []).enabled === false)

    // Cross-account results: nearly every account has an "Inbox", so an
    // unqualified label leaves two rows looking identical.
    const spanning = searchFolderLabels(
      [{ folderId: 'f1', accountId: 'a1' }, { folderId: 'f2', accountId: 'a2' }],
      folders, accounts)
    ok('a folder shared across accounts is qualified by account',
      spanning.get('f1') === 'Inbox · Personal' && spanning.get('f2') === 'Inbox · Work',
      JSON.stringify([...spanning]))

    // ...but qualifying a single-account search is noise; the placeholder has
    // already said whose mail is being searched.
    const oneAccount = searchFolderLabels(
      [{ folderId: 'f1', accountId: 'a1' }, { folderId: 'f3', accountId: 'a1' }],
      folders, accounts)
    ok('results within one account are left unqualified',
      oneAccount.get('f1') === 'Inbox' && oneAccount.get('f3') === 'Receipts',
      JSON.stringify([...oneAccount]))
    ok('no results produces no labels', searchFolderLabels([], folders, accounts).size === 0)
  }

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
