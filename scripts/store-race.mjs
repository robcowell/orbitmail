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
  // When "later" actually means. Pure, and given an explicit `now`, so the
  // arithmetic can be tested without waiting for Tuesday.
  await build({
    entryPoints: [join(root, 'src/utils/snoozePresets.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'snoozePresets.cjs'),
    logLevel: 'silent'
  })

  // How the three panes share the window — the reader is defended, the list
  // and sidebar give way.
  await build({
    entryPoints: [join(root, 'src/utils/paneLayout.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'paneLayout.cjs'),
    logLevel: 'silent'
  })

  // The list header's wording: which folder, how much of it is loaded, and
  // whether a filter is hiding the rest.
  await build({
    entryPoints: [join(root, 'src/utils/listHeader.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'listHeader.cjs'),
    logLevel: 'silent'
  })

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

  // What a failed IPC call is allowed to put in front of the user.
  await build({
    entryPoints: [join(root, 'src/utils/ipcError.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'ipcError.cjs'),
    logLevel: 'silent'
  })

  // A main-process module, deliberately. `describeAccountSyncFailure` writes the
  // sync error prose and `summarizeSyncStatus` decides — by running a regex over
  // that prose — whether to offer a Re-authenticate button. That coupling spans
  // the process boundary, so testing either side alone proves nothing: the only
  // check worth having runs the real producer's strings through the real
  // consumer. Both modules are pure, so both bundle here.
  await build({
    entryPoints: [join(root, 'electron/services/connection-failure.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: join(outDir, 'connectionFailure.cjs'),
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

    // Percentage channels are rounded to a whole 0-255, not truncated — and the
    // percentage has to be one that straddles the *classifier's* boundary, not
    // an arbitrary one. Grey flips at 112/113: at 112 our own light text still
    // reads on it and the mail is left dark, at 113 it does not and the mail
    // gets a light page. 44.2% is 112.71 of 255, so rounding gives 113 and
    // truncating gives 112 — opposite answers about the same colour.
    //
    // Written against 50% first, which proves nothing: 127 and 128 are both on
    // the same side of the boundary, so that pair passes either way. The
    // mutation check is what said so.
    const grey = (v) => assumesLightBackground(`<td style="background:rgb(${v})">Hi</td>`)
    ok('a percentage channel is rounded, matching the 113 it rounds to',
      grey('44.2%,44.2%,44.2%') === grey('113,113,113'),
      `${grey('44.2%,44.2%,44.2%')} vs ${grey('113,113,113')}`)
    ok('and not the 112 it would truncate to, which classifies the other way',
      grey('113,113,113') !== grey('112,112,112'),
      `113 → ${grey('113,113,113')}, 112 → ${grey('112,112,112')}`)

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

    // Each keyword that means "no colour here" on its own. Only `transparent`
    // was covered, so the other three could have been dropped from the guard
    // and nothing would have said — they arrive in real mail from editors that
    // write `color: inherit` on every cell.
    for (const keyword of ['inherit', 'initial', 'currentcolor']) {
      ok(`${keyword} paints nothing, so it implies nothing`,
        !assumesLightBackground(`<div style="background:${keyword}">Hi</div>`) &&
        !assumesLightBackground(`<div style="color:${keyword}">Hi</div>`))
    }
    ok('an empty value implies nothing', !assumesLightBackground('<div style="color: ">Hi</div>'))

    // The alpha thresholds, on both sides. Every existing case used alpha 0 or
    // no alpha at all, so the cutoff could have been anywhere — or inverted.
    ok('a nearly-transparent white background is not a light background',
      !assumesLightBackground('<div style="background:rgba(255,255,255,0.05)">Hi</div>'))
    ok('but a mostly-opaque one is',
      assumesLightBackground('<div style="background:rgba(255,255,255,0.9)">Hi</div>'))
    ok('alpha given as a percentage is read the same way',
      !assumesLightBackground('<div style="background:rgba(255,255,255,5%)">Hi</div>'))
    // Exactly on the cutoff — the one value that tells `<=` from `<`, and a
    // number a person actually types.
    ok('alpha exactly at the cutoff still counts as painting nothing',
      !assumesLightBackground('<div style="background:rgba(255,255,255,0.1)">Hi</div>'))
    ok('and a hair above it counts as painting something',
      assumesLightBackground('<div style="background:rgba(255,255,255,0.11)">Hi</div>'))

    // Hex with alpha, in both lengths. Neither was covered at all: #RGBA and
    // #RRGGBBAA both fall through code that reads the alpha nibble and both
    // could have been ignoring it.
    ok('a four-digit hex with a low alpha paints nothing',
      !assumesLightBackground('<div style="background:#fff1">Hi</div>'))
    ok('a four-digit hex with a full alpha is a light background',
      assumesLightBackground('<div style="background:#ffff">Hi</div>'))
    ok('an eight-digit hex with a low alpha paints nothing',
      !assumesLightBackground('<div style="background:#ffffff10">Hi</div>'))
    ok('an eight-digit hex with a full alpha is a light background',
      assumesLightBackground('<div style="background:#ffffffff">Hi</div>'))
    // 0x19 is 25 — exactly the cutoff, and reachable only in the eight-digit
    // form, since a doubled nibble can never be 25.
    ok('an eight-digit hex whose alpha is exactly the cutoff paints nothing',
      !assumesLightBackground('<div style="background:#ffffff19">Hi</div>'))
    ok('and one byte above it paints something',
      assumesLightBackground('<div style="background:#ffffff1a">Hi</div>'))
    ok('a six-digit hex has no alpha to misread',
      assumesLightBackground('<div style="background:#ffffff">Hi</div>'))
    ok('a hex of a length that is not a colour is ignored',
      !assumesLightBackground('<div style="background:#fffff">Hi</div>'))

    // `background` and `background-color` are two different property names and
    // both must be read. Only one was covered, so either could have been
    // dropped from the condition.
    ok('the shorthand background property is read',
      assumesLightBackground('<div style="background:#ffffff">Hi</div>'))
    ok('and the long form as well',
      assumesLightBackground('<div style="background-color:#ffffff">Hi</div>'))
    ok('a property that merely starts the same is not read as either',
      !assumesLightBackground('<div style="background-image:#ffffff">Hi</div>'))

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
    const { favoriteRowHints, folderParentPath, findAccountFolder } =
      require(join(outDir, 'folders.cjs'))
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
    // One character of parent — "a/Receipts". The guard is `<=`, and only the
    // equal case was covered, so it could have been `<` unnoticed: that would
    // slice this to "" and report a folder with an empty parent.
    ok('a one-character parent is still a parent',
      folderParentPath(folder('f', 'a1', 'Receipts', 'a/Receipts')) === 'a',
      String(folderParentPath(folder('f', 'a1', 'Receipts', 'a/Receipts'))))

    // A folder whose name is unique inside its account gets no parent path — a
    // parent is a disambiguator, and "Work · Receipts" on the only Receipts
    // there is is noise. The count is `> 1` and the folder counts itself, so
    // `>= 1` would qualify every row on the list.
    const twoAccounts = [
      folder('u1', 'a1', 'Receipts', 'Work/Receipts'),
      folder('u2', 'a2', 'Receipts', 'Work/Receipts')
    ]
    const uniqueHints = hints(twoAccounts)
    ok('a name unique within its account is qualified by account alone',
      uniqueHints.get('u1') === 'Personal', String(uniqueHints.get('u1')))
    const twiceInOne = [
      folder('d1', 'a1', 'Receipts', 'Work/Receipts'),
      folder('d2', 'a1', 'Receipts', 'Home/Receipts')
    ]
    ok('and one that repeats inside an account gains its parent',
      hints(twiceInOne).get('d1') === 'Work', String(hints(twiceInOne).get('d1')))

    // findAccountFolder matches on account AND type. Every existing case had a
    // single account, so matching on either alone would have passed.
    const across = [
      folder('x1', 'a1', 'Inbox', 'INBOX'),
      folder('x2', 'a2', 'Inbox', 'INBOX'),
      folder('x3', 'a1', 'Trash', 'Trash')
    ]
    across[0].type = 'inbox'; across[1].type = 'inbox'; across[2].type = 'trash'
    ok('the folder found is the one in the account asked for',
      findAccountFolder(across, 'a2', 'inbox')?.id === 'x2',
      String(findAccountFolder(across, 'a2', 'inbox')?.id))
    ok('and of the type asked for, not merely in that account',
      findAccountFolder(across, 'a1', 'trash')?.id === 'x3',
      String(findAccountFolder(across, 'a1', 'trash')?.id))
    ok('a type the account does not have is not borrowed from another account',
      findAccountFolder(across, 'a2', 'trash') === undefined,
      String(findAccountFolder(across, 'a2', 'trash')?.id))
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
      accountId: id, email, syncing: false, lastSyncAt: null, error: null,
      needsReauth: false, ...over
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
    // must not send the user round an OAuth loop that fixes nothing. The verdict
    // is the main process's, carried on the status — it used to be re-derived
    // here by running a regex over `error`, so the button was a property of the
    // wording and a reworded sentence silently removed it.
    ok('an account flagged by the main process offers re-authentication',
      summarizeSyncStatus(
        status([acct('a', 'a@x', { error: 'invalid_grant', needsReauth: true })])
      ).needsReauth)
    ok('a network failure does not',
      !summarizeSyncStatus(
        status([acct('a', 'a@x', { error: 'no route to host', needsReauth: false })])
      ).needsReauth)
    // The two assertions that prove the regex is gone: the words no longer
    // matter in either direction.
    ok('an error whose wording is full of auth words is not promoted',
      !summarizeSyncStatus(
        status([acct('a', 'a@x', {
          error: 'the token expired while consenting to a login', needsReauth: false
        })])
      ).needsReauth)
    ok('and a flagged failure worded with none of them still offers it',
      summarizeSyncStatus(
        status([acct('a', 'a@x', { error: 'the mail server said no', needsReauth: true })])
      ).needsReauth)

    // The newest wins whichever order the accounts arrive in. Both directions
    // are needed: the reducer's condition has three parts, and each is masked
    // by one ordering and exposed by the other. Every case here used a single
    // healthy account or an already-ascending pair, so three separate mutations
    // to that line survived the suite untouched.
    const ascending = summarizeSyncStatus(status([
      acct('a', 'a@x', { lastSyncAt: 1000 }),
      acct('b', 'b@x', { lastSyncAt: 9000 })
    ]))
    ok('the newest sync wins when the later account is the newer one',
      ascending.healthyLastSyncAt === 9000, String(ascending.healthyLastSyncAt))
    const descending = summarizeSyncStatus(status([
      acct('a', 'a@x', { lastSyncAt: 9000 }),
      acct('b', 'b@x', { lastSyncAt: 1000 })
    ]))
    ok('and when the later account is the older one',
      descending.healthyLastSyncAt === 9000, String(descending.healthyLastSyncAt))

    // An account that has never synced contributes no timestamp but must not
    // erase one. Found by the mutation check: three separate mutations to the
    // reducing condition all survived, because every healthy account in these
    // cases happened to have a time.
    const neverSynced = summarizeSyncStatus(status([
      acct('a', 'a@x', { lastSyncAt: null }),
      acct('b', 'b@x', { lastSyncAt: 5000 })
    ]))
    ok('an account that has never synced does not erase another account\'s time',
      neverSynced.healthyLastSyncAt === 5000, String(neverSynced.healthyLastSyncAt))
    ok('and is not itself reported as a time',
      summarizeSyncStatus(status([acct('a', 'a@x', { lastSyncAt: null })]))
        .healthyLastSyncAt === null)
    ok('with none of them ever synced there is nothing to report',
      summarizeSyncStatus(status([
        acct('a', 'a@x', { lastSyncAt: null }),
        acct('b', 'b@x', { lastSyncAt: null })
      ])).healthyLastSyncAt === null)

    // Every account failing is not "mixed" — there is no healthy one to
    // contrast with, so the bar must not say "Others last synced".
    ok('every account failing is not described as a mix',
      summarizeSyncStatus(status([
        acct('a', 'a@x', { error: 'down', lastSyncAt: 1 }),
        acct('b', 'b@x', { error: 'down', lastSyncAt: 2 })
      ])).mixed === false)

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
      lastSyncAt: null, error: null, needsReauth: false, reachedServer: null, ...over
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
  section('Snooze presets: "later" lands on an hour somebody chose')
  // -------------------------------------------------------------------------
  {
    const { snoozePresets, formatWakeAt } = require(join(outDir, 'snoozePresets.cjs'))
    const at = (iso) => new Date(iso).getTime()
    const get = (now, id) => snoozePresets(at(now)).find((p) => p.id === id)
    const hourOf = (ts) => new Date(ts).getHours()

    // Every preset lands on a whole hour. Now-plus-an-offset would mean a
    // message snoozed at 09:47 arriving at 09:47 tomorrow, and an inbox filling
    // at times nobody picked.
    const morning = at('2026-03-10T09:47:00')
    for (const p of snoozePresets(morning)) {
      if (p.wakeAt === null) continue
      const d = new Date(p.wakeAt)
      ok(`${p.id} lands on a whole hour`,
        d.getMinutes() === 0 && d.getSeconds() === 0,
        d.toISOString())
      ok(`${p.id} is in the future`, p.wakeAt > morning, d.toISOString())
    }

    // "Later today" is the afternoon in the morning, the evening in the
    // afternoon, and absent in the evening — rather than silently meaning
    // tomorrow, which would be a preset that lies about when it fires.
    ok('later today means this afternoon when asked in the morning',
      hourOf(get('2026-03-10T09:00:00', 'later-today').wakeAt) === 14)
    ok('and this evening when asked in the afternoon',
      hourOf(get('2026-03-10T15:00:00', 'later-today').wakeAt) === 18)
    ok('and is offered as nothing at all once the evening has gone',
      get('2026-03-10T21:00:00', 'later-today').wakeAt === null)

    // Exactly on each boundary hour. At 14:00 the afternoon is *now*, so
    // "later today" has to be the evening — a preset that fires at the moment
    // it is offered is the same lie as one that means tomorrow. Both of these
    // comparisons are one character from being wrong and nothing pinned them.
    ok('at exactly the afternoon hour, later today means the evening',
      hourOf(get('2026-03-10T14:00:00', 'later-today').wakeAt) === 18,
      String(hourOf(get('2026-03-10T14:00:00', 'later-today').wakeAt)))
    ok('and at exactly the evening hour there is no later today left',
      get('2026-03-10T18:00:00', 'later-today').wakeAt === null)
    // One minute before each, the earlier option is still the right one.
    ok('a minute before the afternoon it is still the afternoon',
      hourOf(get('2026-03-10T13:59:00', 'later-today').wakeAt) === 14)
    ok('and a minute before the evening it is still the evening',
      hourOf(get('2026-03-10T17:59:00', 'later-today').wakeAt) === 18)

    ok('tomorrow is the next morning',
      hourOf(get('2026-03-10T21:00:00', 'tomorrow').wakeAt) === 8 &&
      new Date(get('2026-03-10T21:00:00', 'tomorrow').wakeAt).getDate() === 11)

    // Tuesday 10 March 2026. Saturday is the 14th, Monday the 16th.
    ok('this weekend is the coming Saturday',
      new Date(get('2026-03-10T09:00:00', 'this-weekend').wakeAt).getDate() === 14)
    ok('next week is the coming Monday',
      new Date(get('2026-03-10T09:00:00', 'next-week').wakeAt).getDate() === 16)

    // The rule that stops a preset firing in the past: asked ON a Saturday,
    // "this weekend" is the NEXT Saturday, not this morning.
    const sat = at('2026-03-14T09:00:00')
    ok('asked on a Saturday, this weekend means the next one',
      get('2026-03-14T09:00:00', 'this-weekend').wakeAt > sat &&
      new Date(get('2026-03-14T09:00:00', 'this-weekend').wakeAt).getDate() === 21)
    const mon = at('2026-03-16T09:00:00')
    ok('and asked on a Monday, next week means the next Monday',
      get('2026-03-16T09:00:00', 'next-week').wakeAt > mon &&
      new Date(get('2026-03-16T09:00:00', 'next-week').wakeAt).getDate() === 23)

    // No preset may ever be in the past, on any day of the week or hour.
    for (let day = 10; day <= 16; day++) {
      for (const hour of ['00:30', '09:00', '15:00', '21:00', '23:45']) {
        const now = at(`2026-03-${day}T${hour}:00`)
        for (const p of snoozePresets(now)) {
          if (p.wakeAt === null) continue
          ok(`no preset fires in the past (day ${day}, ${hour}, ${p.id})`, p.wakeAt > now,
            new Date(p.wakeAt).toISOString())
        }
      }
    }

    // The label a person reads.
    const base = at('2026-03-10T09:00:00')
    ok('a same-day wake reads as a time', !/at/.test(formatWakeAt(at('2026-03-10T14:00:00'), base)))
    ok('tomorrow is named', /^tomorrow at/.test(formatWakeAt(at('2026-03-11T08:00:00'), base)))
    // The weekday's *name* is whatever the locale calls it — "Saturday" here,
    // "Samstag" on a German machine. Compared against the platform's own
    // formatting rather than an English string.
    const weekdayLabel = formatWakeAt(at('2026-03-14T08:00:00'), base)
    const expectedWeekday = new Date(at('2026-03-14T08:00:00'))
      .toLocaleDateString(undefined, { weekday: 'long' })
    ok('a day this week is named by weekday',
      weekdayLabel.startsWith(`${expectedWeekday} at`), weekdayLabel)
    // Asserted without assuming a locale's date order: this ran green on a
    // machine formatting "2 Apr at 8:00" and failed in CI on one formatting
    // "Apr 2 at 8:00 AM". What matters is that it names the month and day
    // rather than a weekday, not which way round they go.
    const far = formatWakeAt(at('2026-04-02T08:00:00'), base)
    ok('and further out by month and day rather than a weekday',
      /Apr/i.test(far) && /\b2\b/.test(far) && !/tomorrow|day at/i.test(far), far)

    // The weekday form is only unambiguous inside six days: at exactly six a
    // weekday name is one day from repeating, so it is the date form that has
    // to appear. Asserting a day inside and a day outside leaves the boundary
    // itself unpinned, which is where an off-by-one lives.
    const sixDays = 6 * 24 * 3600 * 1000
    const atSix = formatWakeAt(base + sixDays, base)
    ok('exactly six days out is a date, not a weekday',
      /Mar/i.test(atSix) && !/day at/i.test(atSix), atSix)
    const justInside = formatWakeAt(base + sixDays - 60_000, base)
    ok('and a minute inside six days is still a weekday',
      /day at/i.test(justInside), justInside)
  }

  // -------------------------------------------------------------------------
  section('Pane layout: the reader is defended, not sacrificed')
  // -------------------------------------------------------------------------
  {
    const {
      fitPanes, MIN_SIDEBAR_WIDTH, MIN_LIST_WIDTH, MIN_READER_WIDTH, DIVIDER_COUNT
    } = require(join(outDir, 'paneLayout.cjs'))

    const fit = (containerWidth, over = {}) => fitPanes({
      containerWidth, sidebarWidth: 240, listWidth: 320, sidebarPreference: null, ...over
    })

    // The exact width at which a requested sidebar stops being affordable: all
    // three panes at their minimum, plus the dividers. At that width it fits
    // and must be shown; one pixel narrower it must not. The sweep either side
    // of it passes whichever way the comparison is written.
    const exact =
      DIVIDER_COUNT + MIN_SIDEBAR_WIDTH + MIN_LIST_WIDTH + MIN_READER_WIDTH
    ok('a sidebar that exactly fits is shown',
      fit(exact, { sidebarPreference: true }).sidebarHidden === false, `${exact}px`)
    ok('and one pixel short of fitting is not',
      fit(exact - 1, { sidebarPreference: true }).sidebarHidden === true, `${exact - 1}px`)

    // The bug: sidebar and list were flex-shrink:0, so the reader absorbed
    // every pixel the window lost and could be squeezed to nothing.
    const wide = fit(1600)
    ok('a wide window gives everyone their preferred width',
      wide.sidebar === 240 && wide.list === 320, JSON.stringify(wide))
    ok('and the reader takes the remainder',
      wide.reader === 1600 - DIVIDER_COUNT - 240 - 320, String(wide.reader))

    // 1000px still fits everyone at their preferred widths — worth pinning, so
    // that "responsive" does not come to mean "fidgets when it need not".
    const roomy = fit(1000)
    ok('a window that still fits is left alone',
      roomy.sidebar === 240 && roomy.list === 320, JSON.stringify(roomy))

    // Squeeze: the list gives way first — a column of rows degrades gracefully,
    // prose does not.
    const medium = fit(900)
    ok('a squeezed window takes it from the list first',
      medium.list < 320 && medium.sidebar === 240, JSON.stringify(medium))
    ok('and the reader keeps its minimum', medium.reader >= MIN_READER_WIDTH,
      String(medium.reader))

    // Then the sidebar, once the list is at its own minimum.
    const tight = fit(820, { sidebarPreference: true })
    ok('once the list is at its minimum the sidebar gives way next',
      tight.list === MIN_LIST_WIDTH && tight.sidebar < 240, JSON.stringify(tight))
    ok('the sidebar never goes below its own minimum',
      tight.sidebar >= MIN_SIDEBAR_WIDTH, String(tight.sidebar))

    // At no width does the reader come out worse than it needs to while there
    // is still room to take from someone else.
    for (const w of [900, 1000, 1100, 1200, 1400, 1920]) {
      const f = fit(w)
      ok(`at ${w}px the reader is not squeezed below its minimum`,
        f.reader >= MIN_READER_WIDTH, JSON.stringify(f))
    }

    // Below the breakpoint the sidebar is not worth 180px — the folder list is
    // one click away behind the toggle, the reader is not.
    ok('the sidebar collapses on its own at narrow widths', fit(700).sidebarHidden === true)
    ok('and stays visible above the breakpoint', fit(1200).sidebarHidden === false)
    ok('a hidden sidebar takes no width', fit(700).sidebar === 0, String(fit(700).sidebar))

    // The preference wins over the breakpoint, in both directions.
    ok('asking for it keeps it at a narrow width',
      fit(1000, { sidebarPreference: true }).sidebarHidden === false)
    ok('and hiding it is respected at a wide one',
      fit(1600, { sidebarPreference: false }).sidebarHidden === true)

    // ...but not into an unusable window: asking for a sidebar that cannot fit
    // alongside two usable panes loses to arithmetic.
    const impossible = fit(600, { sidebarPreference: true })
    ok('a sidebar that cannot fit is hidden even when asked for',
      impossible.sidebarHidden === true, JSON.stringify(impossible))

    // Nothing may overflow the window — a horizontal scrollbar on the whole app
    // is worse than a narrow reader.
    for (const w of [400, 600, 700, 900, 1000, 1600]) {
      const f = fit(w)
      const dividers = f.sidebarHidden ? 1 : DIVIDER_COUNT
      ok(`at ${w}px the panes add up to the window`,
        f.sidebar + f.list + f.reader + dividers === w,
        JSON.stringify({ ...f, sum: f.sidebar + f.list + f.reader + dividers }))
    }

    // Before the first measurement there is nothing sensible to compute. The
    // weak version of this ("reader >= 0") was satisfied by almost any
    // behaviour, including deleting the guard: nothing observed that the
    // preferred widths come back untouched.
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = fit(bad)
      ok(`an unmeasured container (${bad}) returns the preferred widths untouched`,
        f.sidebar === 240 && f.list === 320 && f.reader === MIN_READER_WIDTH &&
        f.sidebarHidden === false,
        JSON.stringify(f))
    }

    // Properties, over every width the window can take rather than a handful of
    // round numbers. Individual cases kept missing boundaries — MIN_READER_WIDTH
    // exactly, the point where the sidebar stops fitting — because those are
    // precisely the widths nobody picks by hand.
    // From 1px, not 300. The clamp's own bounds only bind in windows narrower
    // than a single pane's minimum — impossible through the UI today, but the
    // helper is general and two mutations to it survived a loop that started
    // at a comfortable width.
    for (let w = 1; w <= 2200; w += w < 420 ? 1 : 7) {
      for (const pref of [null, true, false]) {
        for (const [sw, lw] of [[240, 320], [180, 200], [400, 500], [180, 900]]) {
          const f = fitPanes({
            containerWidth: w, sidebarWidth: sw, listWidth: lw, sidebarPreference: pref
          })
          const dividers = f.sidebarHidden ? 1 : DIVIDER_COUNT
          const label = `w=${w} pref=${pref} sw=${sw} lw=${lw}`

          if (f.sidebar + f.list + f.reader + dividers !== w) {
            ok(`panes sum to the window (${label})`, false, JSON.stringify(f))
            break
          }
          if (f.sidebar < 0 || f.list < 0 || f.reader < 0) {
            ok(`no pane is negative (${label})`, false, JSON.stringify(f))
            break
          }
          if (f.sidebarHidden && f.sidebar !== 0) {
            ok(`a hidden sidebar has no width (${label})`, false, JSON.stringify(f))
            break
          }
          if (!f.sidebarHidden && f.sidebar < MIN_SIDEBAR_WIDTH) {
            ok(`a shown sidebar keeps its minimum (${label})`, false, JSON.stringify(f))
            break
          }
          // The reader keeps its minimum whenever the window is big enough for
          // two usable panes at all. Below that there is nothing to apportion.
          const roomForTwo = w - 1 - MIN_LIST_WIDTH >= MIN_READER_WIDTH
          if (roomForTwo && f.reader < MIN_READER_WIDTH) {
            ok(`the reader keeps its minimum wherever it can (${label})`, false, JSON.stringify(f))
            break
          }
          if (roomForTwo && f.list < MIN_LIST_WIDTH) {
            ok(`the list keeps its minimum wherever it can (${label})`, false, JSON.stringify(f))
            break
          }
        }
      }
    }
    ok('every layout from 1px to 2200px holds its invariants', true,
      'sum, non-negative, minimums, hidden-sidebar-has-no-width')

    // Each pane gives up only what is needed. Without this, a squeeze that took
    // one pixel too many from the sidebar satisfied every invariant above —
    // the sum still held and every minimum was still met.
    let overTaken = null
    for (let w = 640; w <= 1400 && !overTaken; w += 1) {
      const f = fitPanes({
        containerWidth: w, sidebarWidth: 240, listWidth: 320, sidebarPreference: true
      })
      if (f.sidebarHidden) continue
      // If the sidebar was shrunk at all, the reader must be at exactly its
      // minimum — otherwise the sidebar gave up more than the reader needed.
      if (f.sidebar < 240 && f.reader > MIN_READER_WIDTH) {
        overTaken = { w, ...f }
      }
    }
    ok('a squeezed pane gives up no more than the reader needed',
      overTaken === null, JSON.stringify(overTaken))

    // A preference below the minimum yields *exactly* the minimum, not the
    // nearest other bound. Both of the clamp's bounds could be swapped without
    // any invariant noticing: the sums still held and every minimum was still
    // met, because "at least the minimum" is satisfied by too much as well as
    // by the right amount.
    let wrongFloor = null
    for (let w = 2; w <= 1400 && !wrongFloor; w += 1) {
      const f = fitPanes({
        containerWidth: w, sidebarWidth: 0, listWidth: 0, sidebarPreference: false
      })
      const available = w - 1
      const expected = Math.min(MIN_LIST_WIDTH, available)
      if (f.list !== expected) wrongFloor = { w, expected, got: f.list, ...f }
    }
    ok('a list preference below the minimum gets exactly the minimum',
      wrongFloor === null, JSON.stringify(wrongFloor))
  }

  // -------------------------------------------------------------------------
  section('List header: says which folder, how much of it, and what is hidden')
  // -------------------------------------------------------------------------
  {
    const { describeListHeader } = require(join(outDir, 'listHeader.cjs'))

    const accounts = [
      { id: 'a1', email: 'me@personal.example', displayName: 'Personal', provider: 'imap' },
      { id: 'a2', email: 'me@work.example', displayName: 'Work', provider: 'imap' }
    ]
    const folders = [
      { id: 'f1', accountId: 'a1', name: 'Inbox', type: 'inbox', unreadCount: 3, isVirtualView: false },
      { id: 'f2', accountId: 'a2', name: 'Inbox', type: 'inbox', unreadCount: 5, isVirtualView: false }
    ]
    const base = {
      folders, accounts, threadedView: true, unreadOnly: false,
      loaded: 20, total: 143, searching: false
    }

    const folderView = describeListHeader({ ...base, selectedFolderId: 'f1' })
    ok('the folder is named', folderView.title === 'Inbox', folderView.title)
    ok('and qualified by account when there is more than one',
      folderView.subtitle === 'Personal', String(folderView.subtitle))
    ok('a partly-loaded list says so rather than claiming the full count',
      folderView.count === '20 of 143 conversations', folderView.count)
    ok('unread is reported for that folder alone',
      folderView.unread === '3 unread', String(folderView.unread))

    // With one account the answer to "whose folder?" is never in doubt.
    const single = describeListHeader({
      ...base, selectedFolderId: 'f1', accounts: [accounts[0]], folders: [folders[0]] })
    ok('a single account is not spelled out on every folder',
      single.subtitle === null, String(single.subtitle))

    const unified = describeListHeader({ ...base, selectedFolderId: 'unified' })
    ok('the unified view names itself', unified.title === 'All Inboxes', unified.title)
    ok('and totals unread across accounts', unified.unread === '8 unread', String(unified.unread))

    // A fully-loaded folder still reports its size — this is what was missing
    // entirely, since the count only ever appeared on the "Load more" button.
    const full = describeListHeader({ ...base, selectedFolderId: 'f1', loaded: 143 })
    ok('a fully-loaded list still reports how many there are',
      full.count === '143 conversations', full.count)

    ok('flat view counts messages, not conversations',
      describeListHeader({ ...base, selectedFolderId: 'f1', threadedView: false, loaded: 143 })
        .count === '143 messages')
    ok('one is singular',
      describeListHeader({ ...base, selectedFolderId: 'f1', loaded: 1, total: 1 })
        .count === '1 conversation')
    ok('empty says so in words',
      describeListHeader({ ...base, selectedFolderId: 'f1', loaded: 0, total: 0 })
        .count === 'no conversations')
    // Grouped the way the platform groups: "12,000" here, "12.000" in German.
    // Comparing against a hardcoded comma tested the machine, not the code.
    ok('and large counts are grouped for reading',
      describeListHeader({ ...base, selectedFolderId: 'f1', loaded: 12000, total: 12000 })
        .count === `${(12000).toLocaleString()} conversations`,
      describeListHeader({ ...base, selectedFolderId: 'f1', loaded: 12000, total: 12000 }).count)

    // The filter had no textual cue at all: a pressed toggle was the only sign,
    // which is easy to leave on and then wonder where the mail went. It is
    // folded into the noun rather than shown as a badge, because a badge beside
    // the count was clipped away at the list pane's real width.
    const filtered = describeListHeader({
      ...base, selectedFolderId: 'f1', unreadOnly: true, loaded: 3, total: 3 })
    ok('an active unread filter is stated in the count itself',
      filtered.count === '3 unread conversations', filtered.count)
    ok('and unread is not repeated beside a count that already means unread',
      filtered.unread === null, String(filtered.unread))
    ok('the filtered singular reads properly',
      describeListHeader({ ...base, selectedFolderId: 'f1', unreadOnly: true, loaded: 1, total: 1 })
        .count === '1 unread conversation')
    ok('and an empty filtered folder says so',
      describeListHeader({ ...base, selectedFolderId: 'f1', unreadOnly: true, loaded: 0, total: 0 })
        .count === 'no unread conversations')
    ok('a folder with nothing unread says nothing about unread',
      describeListHeader({
        ...base, selectedFolderId: 'f1',
        folders: [{ ...folders[0], unreadCount: 0 }, folders[1]]
      }).unread === null)
    ok('searching is not described as a filtered folder',
      describeListHeader({
        ...base, selectedFolderId: 'f1', unreadOnly: true, searching: true, loaded: 143
      }).count === '143 conversations')
    ok('an unknown folder still gets a title rather than an empty header',
      describeListHeader({ ...base, selectedFolderId: 'gone' }).title === 'Mailbox')
  }

  // -------------------------------------------------------------------------
  section('Undo: only what can actually be put back is offered')
  // -------------------------------------------------------------------------
  {
    const msg = (id, over = {}) => ({
      id, accountId: 'a1', folderId: 'inbox', messageId: '<' + id + '@x>', ...over
    })

    // The ordinary case: three messages moved to Trash, all restorable.
    const deleted = store.buildUndo(
      'Deleted 3 conversations',
      [msg('m1'), msg('m2'), msg('m3')],
      [
        { id: 'm1', targetFolderId: 'trash' },
        { id: 'm2', targetFolderId: 'trash' },
        { id: 'm3', targetFolderId: 'trash' }
      ]
    )
    ok('a move records one entry per message', deleted?.entries.length === 3,
      String(deleted?.entries.length))
    ok('and each entry points back at the folder it came from',
      deleted?.entries.every((e) => e.folderId === 'inbox'),
      JSON.stringify(deleted?.entries.map((e) => e.folderId)))
    ok('nothing is reported as unrestorable', deleted?.skipped === 0, String(deleted?.skipped))

    // targetFolderId null means the server expunged it — deleting from Trash.
    // There is nothing to move back, and claiming otherwise would be a lie.
    const expunged = store.buildUndo(
      'Deleted 2 conversations',
      [msg('m1'), msg('m2')],
      [
        { id: 'm1', targetFolderId: 'trash' },
        { id: 'm2', targetFolderId: null }
      ]
    )
    ok('an expunged message is not offered for undo', expunged?.entries.length === 1,
      String(expunged?.entries.length))
    ok('and is counted so the toast can say so', expunged?.skipped === 1,
      String(expunged?.skipped))

    // No Message-ID means no handle that survives the move.
    const headerless = store.buildUndo(
      'Deleted', [msg('m1', { messageId: null })], [{ id: 'm1', targetFolderId: 'trash' }])
    ok('a message with no Message-ID cannot be undone', headerless === null,
      JSON.stringify(headerless))

    // Offering "Undo" that would restore nothing is worse than offering nothing.
    const allExpunged = store.buildUndo(
      'Deleted 2', [msg('m1'), msg('m2')],
      [{ id: 'm1', targetFolderId: null }, { id: 'm2', targetFolderId: null }])
    ok('undo is not offered at all when nothing can be restored', allExpunged === null,
      JSON.stringify(allExpunged))

    // An item with no matching message row is a bug, not a restorable entry.
    const orphan = store.buildUndo('Deleted', [], [{ id: 'gone', targetFolderId: 'trash' }])
    ok('an item with no message behind it is skipped, not guessed at', orphan === null)

    ok('the label is carried through for the toast',
      deleted?.label === 'Deleted 3 conversations', deleted?.label)
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

    // A folder whose account is gone. Only "neither exists" was covered, so
    // the two halves of the guard were interchangeable as far as the suite was
    // concerned — and this is the case that actually happens, when an account
    // is removed while one of its folders is still the selected one.
    const orphanFolder = resolveSearchScope(
      'f1', folders, accounts.filter((a) => a.id !== 'a1'))
    ok('a folder whose account has been removed is not searchable',
      orphanFolder.enabled === false, JSON.stringify(orphanFolder))
    ok('and is not promoted to searching every remaining account',
      orphanFolder.accountId === null, String(orphanFolder.accountId))

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

  // -------------------------------------------------------------------------
  section('Re-authenticate: carried as a flag, not inferred from the wording')
  // -------------------------------------------------------------------------
  {
    // This used to be a regex — /auth|token|login|expired|invalid_grant|consent/i
    // run in the renderer over prose written in the main process. The button was
    // therefore a property of the wording: rewording a sentence could silently
    // remove the user's only way out of a failing account, and a DNS failure
    // whose message happened to contain "token" offered a pointless re-auth.
    //
    // The flag is set where the failure is classified and travels on the status.
    // Both modules are pure, so this runs the real producer's verdict through
    // the real consumer — which is the only thing that proves they agree.
    const { summarizeSyncStatus } = require(join(outDir, 'syncStatus.cjs'))
    const { describeAccountSyncFailure, markReauthRequired } =
      require(join(outDir, 'connectionFailure.cjs'))

    const withCode = (code, message = 'x') => Object.assign(new Error(message), { code })
    const imapAuth = Object.assign(new Error('Command failed'), {
      authenticationFailed: true,
      response: '3 NO [AUTHENTICATIONFAILED] Invalid credentials'
    })

    // The real end-to-end shape: what the main process would store, read by the
    // renderer exactly as it reads it in the app.
    const summarize = (err) => {
      const { message, needsReauth } = describeAccountSyncFailure(err)
      return summarizeSyncStatus({
        syncing: false, lastSyncAt: null, syncCurrent: 0, syncTotal: 0,
        accounts: {
          a1: {
            accountId: 'a1', email: 'a@b.test', syncing: false, lastSyncAt: null,
            error: message, needsReauth
          }
        }
      })
    }

    ok('a rejected login offers Re-authenticate',
      summarize(imapAuth).needsReauth === true)

    for (const [label, err] of [
      ['a hostname typo', withCode('ENOTFOUND')],
      ['a refused connection', withCode('ECONNREFUSED')],
      ['a timeout', withCode('ETIMEDOUT')],
      ['a certificate mismatch', withCode('ERR_TLS_CERT_ALTNAME_INVALID')]
    ]) {
      ok(`${label} does not offer a pointless Re-authenticate`,
        summarize(err).needsReauth === false, describeAccountSyncFailure(err).message)
    }

    // An OAuth failure is a sentence we wrote, not anything a server said, so no
    // classifier can read it — the throwing code marks it instead. This is the
    // case the regex used to catch by accident, and the one most likely to be
    // lost in a rewrite.
    ok('a marked OAuth failure still offers Re-authenticate',
      summarize(markReauthRequired(
        new Error('No refresh token stored for a@b. Remove the account and sign in again.')
      )).needsReauth === true)

    // The regex is gone, and these two prove it in both directions: wording full
    // of the old trigger words must not raise the button, and a flagged failure
    // containing none of them must still raise it. Under the old inference the
    // first of these was a false positive and the second a false negative.
    ok('wording alone no longer raises the button',
      summarize(new Error('the token expired while consenting to a login')).needsReauth === false,
      describeAccountSyncFailure(new Error('the token expired while consenting to a login')).message)

    const plainAuth = Object.assign(new Error('Invalid login: 535 Bad credentials'), {
      code: 'EAUTH', response: '535 5.7.8 Bad credentials'
    })
    ok('and a credential failure quoting no trigger word still does',
      summarize(plainAuth).needsReauth === true,
      describeAccountSyncFailure(plainAuth).message)
  }

  // -------------------------------------------------------------------------
  section('IPC errors: the user sees the message, not the plumbing')
  // -------------------------------------------------------------------------
  {
    const { ipcErrorMessage } = require(join(outDir, 'ipcError.cjs'))

    // Electron wraps every rejection that crosses the boundary. Adding an
    // account failed with exactly this on screen, and the part that mattered
    // was never reached: a toast is one line at a bounded width.
    const wrapped = new Error(
      "Error invoking remote method 'accounts:addManual': Error: Incoming server " +
        '(mailc50.example.eu) rejected the username and password: NO Invalid credentials.'
    )
    const shown = ipcErrorMessage(wrapped, 'Failed to add account')
    ok('the channel wrapper is stripped', !shown.includes('invoking remote method'), shown)
    ok('and so is the Error: tag it leaves behind', !shown.startsWith('Error:'), shown)
    ok('the message itself survives whole',
      shown.startsWith('Incoming server (mailc50.example.eu) rejected') &&
        shown.endsWith('NO Invalid credentials.'),
      shown)

    // A colon inside the real message must not be treated as another wrapper.
    ok('only the leading class tag goes, not a colon in the text',
      ipcErrorMessage(new Error('Error: host: port refused'), 'x') === 'host: port refused',
      ipcErrorMessage(new Error('Error: host: port refused'), 'x'))

    // An unwrapped error is already what we want.
    ok('a plain message is untouched',
      ipcErrorMessage(new Error('No handler registered'), 'x') === 'No handler registered')

    // The fallback exists because a rejection is not always an Error, and an
    // empty toast would say nothing at all.
    ok('a non-error falls back', ipcErrorMessage({ nope: true }, 'Failed to add account') ===
      'Failed to add account')
    ok('an empty message falls back', ipcErrorMessage(new Error('   '), 'Fallback') === 'Fallback')
    ok('a bare wrapper with nothing after it falls back',
      ipcErrorMessage(new Error("Error invoking remote method 'a:b': Error: "), 'Fallback') ===
        'Fallback')
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
