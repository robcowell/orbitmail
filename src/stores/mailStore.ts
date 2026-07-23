import { create } from 'zustand'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  ThreadSummary,
  SyncStatus,
  ManualAccountInput,
  FlagColor,
  AiAnalysis,
  SweepTask,
  CompletedTask,
  SweepScope,
  SearchField,
  DraftTone
} from '../../shared/types'
import {
  loadPersistedPreferences,
  scheduleSaveUiPreferences
} from './persistence'
import { findAccountFolder, findArchiveFolder } from '../utils/folders'
import { buildTasksMarkdown, defaultTasksFilename } from '../utils/taskExport'
import { draftToHtml } from '../utils/replyDraft'

export const MESSAGE_PAGE_SIZE = 200

interface MailState {
  accounts: Account[]
  folders: Folder[]
  messages: MessageSummary[]
  messageOffset: number
  messageTotal: number
  // Conversation threads for the current folder/unified view (non-search).
  threads: ThreadSummary[]
  threadOffset: number
  threadTotal: number
  selectedThreadId: string | null
  selectedThread: MessageDetail[] | null
  threadLoading: boolean
  // Multi-selected conversation rows, as `${accountId} ${threadId}` keys. The
  // lead row stays in selectedThreadId (it drives the reader); these drive bulk
  // actions and the row highlight, mirroring selectedMessageIds in the flat list.
  selectedThreadKeys: string[]
  threadAnchorKey: string | null
  selectedMessageId: string | null
  selectedMessage: MessageDetail | null
  readerLoading: boolean
  // Why the reader is empty when it should not be, and what to retry. Opening a
  // conversation or a message can fail (the fetch is IPC, and the main process
  // can be mid-sync or the row gone); without this the pane sat on "Loading
  // conversation…" forever and the rejection vanished into a `void` call.
  readerError: {
    message: string
    retry:
      | { kind: 'thread'; accountId: string; threadId: string }
      | { kind: 'message'; messageId: string }
  } | null
  selectedMessageIds: string[]
  selectionAnchorId: string | null
  selectedFolderId: string | 'unified'
  searchQuery: string
  searchResults: MessageSummary[]
  // Which field(s) the search matches against (All / From / To / Subject / Body).
  searchField: SearchField
  // True while the server-side search fallback is running (local cache was empty).
  searchLoading: boolean
  // True once a live server search has run for the current query (auto or manual),
  // so the results banner can stop offering "search the whole mailbox".
  serverSearched: boolean
  syncStatus: SyncStatus
  showAddAccount: boolean
  toast: string | null
  loading: boolean
  listLoading: boolean
  isOnline: boolean
  collapsedAccountIds: Record<string, boolean>
  favoriteFolderIds: string[]
  // Senders whose remote images load without the block prompt (persisted).
  imageAllowedSenders: string[]
  // Conversation grouping on/off (persisted). When off, the list is flat.
  threadedView: boolean
  // Per-account "unread only" list filter (persisted). Keyed by account id, plus
  // 'unified' for the combined inbox. Missing/false = show all messages.
  unreadFilterByAccount: Record<string, boolean>
  // Thread keys ("<accountId> <threadId>") currently expanded inline in the
  // list, and a cache of each expanded thread's messages (undefined = loading).
  expandedThreadKeys: string[]
  expandedThreadMessages: Record<string, MessageDetail[]>
  aiAnalysisById: Record<string, AiAnalysis>
  aiAnalyzingId: string | null
  draftingReplyId: string | null
  flaggingTaskId: string | null
  showAiSettings: boolean
  showTasks: boolean
  sweeping: boolean
  sweepTasks: SweepTask[]
  sweepCompleted: CompletedTask[]
  sweepAnalyzedCount: number
  sweepScope: SweepScope
  sweepSweptAt: number | null

  setAccounts: (accounts: Account[]) => void
  setFolders: (folders: Folder[]) => void
  setMessages: (messages: MessageSummary[]) => void
  appendMessages: (messages: MessageSummary[]) => void
  setMessageOffset: (offset: number) => void
  setMessageTotal: (total: number) => void
  setThreads: (threads: ThreadSummary[]) => void
  appendThreads: (threads: ThreadSummary[]) => void
  setThreadOffset: (offset: number) => void
  setThreadTotal: (total: number) => void
  setSelectedThreadId: (id: string | null) => void
  setSelectedThread: (thread: MessageDetail[] | null) => void
  setThreadLoading: (loading: boolean) => void
  setSelectedThreadKeys: (keys: string[]) => void
  setThreadAnchorKey: (key: string | null) => void
  setSelectedMessageId: (id: string | null) => void
  setSelectedMessage: (msg: MessageDetail | null) => void
  setReaderLoading: (loading: boolean) => void
  setReaderError: (error: MailState['readerError']) => void
  setSelectedMessageIds: (ids: string[]) => void
  setSelectionAnchorId: (id: string | null) => void
  setSelectedFolderId: (id: string | 'unified') => void
  setSearchQuery: (q: string) => void
  setSearchResults: (results: MessageSummary[]) => void
  setSearchField: (field: SearchField) => void
  setSearchLoading: (loading: boolean) => void
  setServerSearched: (searched: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setShowAddAccount: (show: boolean) => void
  setToast: (msg: string | null) => void
  setLoading: (loading: boolean) => void
  setListLoading: (loading: boolean) => void
  setIsOnline: (online: boolean) => void
  toggleAccountCollapsed: (accountId: string) => void
  expandAccount: (accountId: string) => void
  toggleFavoriteFolder: (folderId: string) => void
  setImageAllowedSenders: (senders: string[]) => void
  addImageAllowedSender: (email: string) => void
  setThreadedView: (enabled: boolean) => void
  setUnreadFilterByAccount: (map: Record<string, boolean>) => void
  setExpandedThreadKeys: (keys: string[]) => void
  setExpandedThreadMessages: (map: Record<string, MessageDetail[]>) => void
  setAiAnalysis: (messageId: string, analysis: AiAnalysis) => void
  setAiAnalyzingId: (id: string | null) => void
  setDraftingReplyId: (id: string | null) => void
  setFlaggingTaskId: (id: string | null) => void
  setShowAiSettings: (show: boolean) => void
  setShowTasks: (show: boolean) => void
  setSweeping: (sweeping: boolean) => void
  setSweepResult: (
    tasks: SweepTask[],
    completed: CompletedTask[],
    analyzedCount: number,
    sweptAt: number | null
  ) => void
  setSweepScope: (scope: SweepScope) => void
}

export const useMailStore = create<MailState>((set) => ({
  accounts: [],
  folders: [],
  messages: [],
  messageOffset: 0,
  messageTotal: 0,
  threads: [],
  threadOffset: 0,
  threadTotal: 0,
  selectedThreadId: null,
  selectedThread: null,
  threadLoading: false,
  selectedThreadKeys: [],
  threadAnchorKey: null,
  selectedMessageId: null,
  selectedMessage: null,
  readerLoading: false,
  readerError: null,
  selectedMessageIds: [],
  selectionAnchorId: null,
  selectedFolderId: 'unified',
  searchQuery: '',
  searchResults: [],
  searchField: 'all',
  searchLoading: false,
  serverSearched: false,
  syncStatus: { syncing: false, lastSyncAt: null, error: null, syncCurrent: 0, syncTotal: 0 },
  showAddAccount: false,
  toast: null,
  loading: false,
  listLoading: false,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  collapsedAccountIds: {},
  favoriteFolderIds: [],
  imageAllowedSenders: [],
  threadedView: true,
  unreadFilterByAccount: {},
  expandedThreadKeys: [],
  expandedThreadMessages: {},
  aiAnalysisById: {},
  aiAnalyzingId: null,
  draftingReplyId: null,
  flaggingTaskId: null,
  showAiSettings: false,
  showTasks: false,
  sweeping: false,
  sweepTasks: [],
  sweepCompleted: [],
  sweepAnalyzedCount: 0,
  sweepScope: 'unread',
  sweepSweptAt: null,

  setAccounts: (accounts) => set({ accounts }),
  setFolders: (folders) => set({ folders }),
  setMessages: (messages) => set({ messages }),
  appendMessages: (messages) =>
    set((state) => ({ messages: [...state.messages, ...messages] })),
  setMessageOffset: (offset) => set({ messageOffset: offset }),
  setMessageTotal: (total) => set({ messageTotal: total }),
  setThreads: (threads) => set({ threads }),
  appendThreads: (threads) => set((state) => ({ threads: [...state.threads, ...threads] })),
  setThreadOffset: (offset) => set({ threadOffset: offset }),
  setThreadTotal: (total) => set({ threadTotal: total }),
  setSelectedThreadId: (id) => set({ selectedThreadId: id }),
  setSelectedThread: (thread) => set({ selectedThread: thread }),
  setThreadLoading: (loading) => set({ threadLoading: loading }),
  setSelectedThreadKeys: (keys) => set({ selectedThreadKeys: keys }),
  setThreadAnchorKey: (key) => set({ threadAnchorKey: key }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
  setReaderLoading: (loading) => set({ readerLoading: loading }),
  setReaderError: (error) => set({ readerError: error }),
  setSelectedMessageIds: (ids) => set({ selectedMessageIds: ids }),
  setSelectionAnchorId: (id) => set({ selectionAnchorId: id }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSearchField: (field) => {
    set({ searchField: field })
    scheduleSaveUiPreferences({ searchField: field })
  },
  setSearchLoading: (loading) => set({ searchLoading: loading }),
  setServerSearched: (searched) => set({ serverSearched: searched }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setShowAddAccount: (show) => set({ showAddAccount: show }),
  setToast: (msg) => set({ toast: msg }),
  setLoading: (loading) => set({ loading }),
  setListLoading: (loading) => set({ listLoading: loading }),
  setIsOnline: (online) => set({ isOnline: online }),
  setAiAnalysis: (messageId, analysis) =>
    set((state) => ({ aiAnalysisById: { ...state.aiAnalysisById, [messageId]: analysis } })),
  setAiAnalyzingId: (id) => set({ aiAnalyzingId: id }),
  setDraftingReplyId: (id) => set({ draftingReplyId: id }),
  setFlaggingTaskId: (id) => set({ flaggingTaskId: id }),
  setShowAiSettings: (show) => set({ showAiSettings: show }),
  setShowTasks: (show) => set({ showTasks: show }),
  setSweeping: (sweeping) => set({ sweeping }),
  setSweepResult: (tasks, completed, analyzedCount, sweptAt) =>
    set({
      sweepTasks: tasks,
      sweepCompleted: completed,
      sweepAnalyzedCount: analyzedCount,
      sweepSweptAt: sweptAt
    }),
  setSweepScope: (scope) => set({ sweepScope: scope }),
  toggleAccountCollapsed: (accountId) =>
    set((state) => {
      const collapsedAccountIds = {
        ...state.collapsedAccountIds,
        [accountId]: !state.collapsedAccountIds[accountId]
      }
      scheduleSaveUiPreferences({ collapsedAccountIds })
      return { collapsedAccountIds }
    }),
  expandAccount: (accountId) =>
    set((state) => {
      const collapsedAccountIds = {
        ...state.collapsedAccountIds,
        [accountId]: false
      }
      scheduleSaveUiPreferences({ collapsedAccountIds })
      return { collapsedAccountIds }
    }),
  toggleFavoriteFolder: (folderId) =>
    set((state) => {
      const has = state.favoriteFolderIds.includes(folderId)
      const favoriteFolderIds = has
        ? state.favoriteFolderIds.filter((id) => id !== folderId)
        : [...state.favoriteFolderIds, folderId]
      scheduleSaveUiPreferences({ favoriteFolderIds })
      return { favoriteFolderIds }
    }),
  setThreadedView: (enabled) => set({ threadedView: enabled }),

  setImageAllowedSenders: (senders) => set({ imageAllowedSenders: senders }),
  addImageAllowedSender: (email) =>
    set((state) => {
      const normalized = email.trim().toLowerCase()
      if (!normalized || state.imageAllowedSenders.includes(normalized)) return {}
      return { imageAllowedSenders: [...state.imageAllowedSenders, normalized] }
    }),
  setUnreadFilterByAccount: (map) => set({ unreadFilterByAccount: map }),
  setExpandedThreadKeys: (keys) => set({ expandedThreadKeys: keys }),
  setExpandedThreadMessages: (map) => set({ expandedThreadMessages: map })
}))

// Optimistically drop messages from the visible list (and search results) so the
// UI reflects a delete/move instantly, independent of the server round-trip.
function removeMessagesFromList(ids: string[]): void {
  if (ids.length === 0) return
  const idSet = new Set(ids)
  const store = useMailStore.getState()
  const nextMessages = store.messages.filter((m) => !idSet.has(m.id))
  const removed = store.messages.length - nextMessages.length
  store.setMessages(nextMessages)
  store.setSearchResults(store.searchResults.filter((m) => !idSet.has(m.id)))
  if (removed > 0) store.setMessageTotal(Math.max(0, store.messageTotal - removed))
}

// The row an action should land on when it takes the current row out of the
// list: the next one *down* — the row that slides up into the removed one's
// place — falling back to the row above when the removed rows sat at the bottom.
// (Apple Mail, Outlook and Thunderbird all advance downwards and only step back
// at the end of the list.) Call this *before* dropping the rows, while the
// removed ones are still in the list.
function successorMessageId(removedIds: string[]): string | null {
  const store = useMailStore.getState()
  const list = displayedMessages(store)
  const removed = new Set(removedIds)

  let first = -1
  let last = -1
  list.forEach((m, i) => {
    if (!removed.has(m.id)) return
    if (first === -1) first = i
    last = i
  })
  if (first === -1) return null

  for (let i = last + 1; i < list.length; i++) {
    if (!removed.has(list[i].id)) return list[i].id
  }
  for (let i = first - 1; i >= 0; i--) {
    if (!removed.has(list[i].id)) return list[i].id
  }
  return null
}

// Same rule for the threaded view: the next conversation down, else the one above.
function successorThread(accountId: string, threadId: string): ThreadSummary | null {
  const list = useMailStore.getState().threads
  const idx = list.findIndex((t) => t.threadId === threadId && t.accountId === accountId)
  if (idx === -1) return null
  return list[idx + 1] ?? list[idx - 1] ?? null
}

// Rows whose removal is optimistic in the UI but not yet done in the DB.
//
// The main process only deletes the local row *after* the IMAP round-trip
// returns, so for the whole duration of a delete/archive/move the list says
// "gone" and SQLite still says "here". Any refresh in that window — the
// `sync:messagesUpdated` debounce, the sync-complete subscription, a background
// poll or an IDLE push, none of which know an op is in flight — reloads the page
// from SQLite and the row comes back. These sets hold the ids out of any page
// applied while the op is in flight; `withPendingRemoval` releases them once it
// has settled, by which time the local row is really gone.
const pendingRemovedIds = new Set<string>()
const pendingRemovedThreadKeys = new Set<string>()

// Run the server half of a removal with its rows held out of the list. Releasing
// in `finally` means a failure releases them *before* the caller's catch runs its
// rollback refresh, so a rejected delete puts the row back.
async function withPendingRemoval<T>(
  ids: string[],
  threadKeys: string[],
  op: () => Promise<T>
): Promise<T> {
  ids.forEach((id) => pendingRemovedIds.add(id))
  threadKeys.forEach((key) => pendingRemovedThreadKeys.add(key))
  try {
    return await op()
  } finally {
    ids.forEach((id) => pendingRemovedIds.delete(id))
    threadKeys.forEach((key) => pendingRemovedThreadKeys.delete(key))
  }
}

// Drop rows from the visible list and carry the selection to the successor, so
// delete / archive / move can be fired repeatedly without re-picking a row. Rows
// that were not selected are removed without disturbing the open reader.
function removeMessagesAndAdvance(ids: string[]): void {
  const store = useMailStore.getState()
  const selected = new Set(
    [store.selectedMessageId, ...store.selectedMessageIds].filter((id): id is string => !!id)
  )
  const wasSelected = ids.some((id) => selected.has(id))
  const nextId = wasSelected ? successorMessageId(ids) : null

  removeMessagesFromList(ids)
  if (!wasSelected) return

  store.setSelectedMessageIds([])
  store.setSelectionAnchorId(null)
  if (nextId) {
    void selectMessage(nextId)
    return
  }
  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })
}

// Thread-list counterpart of removeMessagesAndAdvance.
function removeThreadAndAdvance(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  const wasSelected = store.selectedThreadId === threadId
  const next = wasSelected ? successorThread(accountId, threadId) : null

  removeThreadFromList(accountId, threadId)
  const key = expandKey(accountId, threadId)
  if (store.selectedThreadKeys.includes(key)) {
    store.setSelectedThreadKeys(store.selectedThreadKeys.filter((k) => k !== key))
  }
  if (!wasSelected) return

  if (next) {
    void selectThread(next.accountId, next.threadId)
    return
  }
  store.setSelectedThread(null)
  store.setSelectedThreadId(null)
}

// Optimistically patch a single row in the visible list (and search results, and
// the open reader if it matches) so a flag/read/star change shows instantly
// without re-fetching the page. Returns the prior values of the changed fields
// for the matched row so callers can roll back on IPC failure.
function patchMessageInList(
  id: string,
  partial: Partial<MessageSummary>
): Partial<MessageSummary> | null {
  const store = useMailStore.getState()

  // A message row lives in more places than the flat list. In conversation view
  // — the default — `messages` is empty and the row is in the open conversation
  // or an inline-expanded thread instead. Missing those meant no optimistic
  // patch *and* a null return, so the caller's rollback never ran and a rejected
  // star/read/flag left the UI asserting something the server had refused.
  const inList = store.messages.find((m) => m.id === id)
  const inSearch = store.searchResults.find((m) => m.id === id)
  const inThread = store.selectedThread?.find((m) => m.id === id)
  const expandedKey = Object.keys(store.expandedThreadMessages).find((key) =>
    store.expandedThreadMessages[key].some((m) => m.id === id)
  )
  const inExpanded = expandedKey
    ? store.expandedThreadMessages[expandedKey].find((m) => m.id === id)
    : undefined
  const inReader = store.selectedMessage?.id === id ? store.selectedMessage : undefined

  const source = inList ?? inSearch ?? inThread ?? inExpanded ?? inReader
  if (!source) return null

  const before: Partial<MessageSummary> = {}
  for (const key of Object.keys(partial) as (keyof MessageSummary)[]) {
    ;(before as Record<string, unknown>)[key] = source[key]
  }

  if (inList) {
    store.setMessages(store.messages.map((m) => (m.id === id ? { ...m, ...partial } : m)))
  }
  if (inSearch) {
    store.setSearchResults(
      store.searchResults.map((m) => (m.id === id ? { ...m, ...partial } : m))
    )
  }
  if (inReader) {
    store.setSelectedMessage({ ...store.selectedMessage!, ...partial })
  }
  if (inThread && store.selectedThread) {
    store.setSelectedThread(
      store.selectedThread.map((m) => (m.id === id ? { ...m, ...partial } : m))
    )
    // Keep the collapsed row's unread dot and star in step with its messages.
    if (store.selectedThreadId) {
      recomputeThreadAggregate(inThread.accountId, store.selectedThreadId)
    }
  }
  if (expandedKey && inExpanded) {
    const patched = store.expandedThreadMessages[expandedKey].map((m) =>
      m.id === id ? { ...m, ...partial } : m
    )
    store.setExpandedThreadMessages({
      ...store.expandedThreadMessages,
      [expandedKey]: patched
    })
    const [accountId, threadId] = expandedKey.split(' ')
    if (accountId && threadId) {
      patchThreadRow(accountId, threadId, {
        hasUnread: patched.some((m) => !m.isRead),
        isStarred: patched.some((m) => m.isStarred)
      })
    }
  }

  return before
}

// Recompute a folder's unread badge locally from the current list so the sidebar
// count tracks an optimistic read/unread flip without a folders re-fetch.
async function refreshFoldersUnread(): Promise<void> {
  const folders = await window.orbitMail.folders.list()
  useMailStore.getState().setFolders(folders)
}

// ---------------------------------------------------------------------------
// Conversation threads (non-search folder/unified views).
// ---------------------------------------------------------------------------

const THREAD_PAGE_SIZE = MESSAGE_PAGE_SIZE

function threadKey(t: ThreadSummary): string {
  return `${t.accountId} ${t.threadId}`
}

function threadUnchanged(a: ThreadSummary, b: ThreadSummary): boolean {
  return (
    a.threadId === b.threadId &&
    a.accountId === b.accountId &&
    a.latestMessageId === b.latestMessageId &&
    a.date === b.date &&
    a.messageCount === b.messageCount &&
    a.hasUnread === b.hasUnread &&
    a.isStarred === b.isStarred &&
    a.flagColor === b.flagColor &&
    a.subject === b.subject &&
    a.snippet === b.snippet
  )
}

// Reference-preserving merge (mirrors mergeMessageList) so unchanged thread rows
// keep identity and the list doesn't flicker on background refresh.
function mergeThreadList(current: ThreadSummary[], next: ThreadSummary[]): ThreadSummary[] {
  const byKey = new Map(current.map((t) => [threadKey(t), t]))
  let changed = current.length !== next.length
  const merged = next.map((n) => {
    const existing = byKey.get(threadKey(n))
    if (existing && threadUnchanged(existing, n)) return existing
    changed = true
    return n
  })
  return changed ? merged : current
}

// A page can be read from SQLite before an in-flight removal reaches it and be
// applied after — so rows are filtered against the pending set as it stood when
// the query was issued *and* as it stands now. The counts drop with them, matching
// the optimistic accounting in removeMessagesFromList.
function applyThreadPage(
  threads: ThreadSummary[],
  total: number,
  offset: number,
  pendingAtRequest: Set<string>
): void {
  const store = useMailStore.getState()
  const visible = threads.filter((t) => {
    const key = threadKey(t)
    return !pendingAtRequest.has(key) && !pendingRemovedThreadKeys.has(key)
  })
  const held = threads.length - visible.length
  if (offset === 0) {
    const merged = mergeThreadList(store.threads, visible)
    if (merged !== store.threads) store.setThreads(merged)
  } else {
    store.appendThreads(visible)
  }
  store.setThreadOffset(offset + threads.length)
  const adjusted = Math.max(0, total - held)
  if (store.threadTotal !== adjusted) store.setThreadTotal(adjusted)
}

// Resolve the per-account filter key for a folder view: the folder's owning
// account, or 'unified' for the combined inbox / an unknown folder.
function filterKeyForFolder(folderId: string | 'unified'): string {
  if (folderId === 'unified') return 'unified'
  const folder = useMailStore.getState().folders.find((f) => f.id === folderId)
  return folder?.accountId ?? 'unified'
}

// Whether the given folder view is currently filtered to unread messages only.
function unreadOnlyForFolder(folderId: string | 'unified'): boolean {
  return useMailStore.getState().unreadFilterByAccount[filterKeyForFolder(folderId)] ?? false
}

async function loadFolderThreads(folderId: string | 'unified', offset = 0): Promise<void> {
  const unreadOnly = unreadOnlyForFolder(folderId)
  const pendingAtRequest = new Set(pendingRemovedThreadKeys)
  const [threads, total] = await Promise.all([
    window.orbitMail.messages.listThreads(folderId, THREAD_PAGE_SIZE, offset, unreadOnly),
    window.orbitMail.messages.countThreads(folderId, unreadOnly)
  ])
  applyThreadPage(threads, total, offset, pendingAtRequest)
}

function applyMessagePage(
  messages: MessageSummary[],
  total: number,
  offset: number,
  pendingAtRequest: Set<string>
): void {
  const store = useMailStore.getState()
  const visible = messages.filter(
    (m) => !pendingAtRequest.has(m.id) && !pendingRemovedIds.has(m.id)
  )
  const held = messages.length - visible.length
  if (offset === 0) store.setMessages(visible)
  else store.appendMessages(visible)
  store.setMessageOffset(offset + messages.length)
  const adjusted = Math.max(0, total - held)
  if (store.messageTotal !== adjusted) store.setMessageTotal(adjusted)
}

// Flat (unthreaded) list of every message in the folder, newest first.
async function loadFolderMessages(folderId: string | 'unified', offset = 0): Promise<void> {
  const unreadOnly = unreadOnlyForFolder(folderId)
  const pendingAtRequest = new Set(pendingRemovedIds)
  const [messages, total] = await Promise.all([
    window.orbitMail.messages.list(folderId, MESSAGE_PAGE_SIZE, offset, unreadOnly),
    window.orbitMail.messages.count(folderId, unreadOnly)
  ])
  applyMessagePage(messages, total, offset, pendingAtRequest)
}

// Load the current folder's list in whichever mode is active.
async function loadFolderList(folderId: string | 'unified', offset = 0): Promise<void> {
  if (useMailStore.getState().threadedView) await loadFolderThreads(folderId, offset)
  else await loadFolderMessages(folderId, offset)
}

// Flip conversation grouping on/off, persist it, and reload the current folder.
export async function toggleThreadedView(): Promise<void> {
  const store = useMailStore.getState()
  const threadedView = !store.threadedView
  store.setThreadedView(threadedView)
  scheduleSaveUiPreferences({ threadedView })

  // Clear selection + both list backings so the switch doesn't show stale rows.
  store.setReaderError(null)
  store.setSelectedThreadId(null)
  store.setSelectedThread(null)
  store.setSelectedThreadKeys([])
  store.setThreadAnchorKey(null)
  store.setSelectedMessageId(null)
  store.setSelectedMessage(null)
  store.setSelectedMessageIds([])
  store.setExpandedThreadKeys([])
  store.setExpandedThreadMessages({})
  store.setThreads([])
  store.setThreadTotal(0)
  store.setThreadOffset(0)
  store.setMessages([])
  store.setMessageTotal(0)
  store.setMessageOffset(0)

  store.setListLoading(true)
  try {
    await loadFolderList(store.selectedFolderId, 0)
  } finally {
    store.setListLoading(false)
  }
}

// Whether the current folder view is filtered to unread only (for the toolbar).
export function isUnreadOnlyView(state: MailState): boolean {
  const folderId = state.selectedFolderId
  const key =
    folderId === 'unified'
      ? 'unified'
      : state.folders.find((f) => f.id === folderId)?.accountId ?? 'unified'
  return state.unreadFilterByAccount[key] ?? false
}

// Flip the current account's "unread only" filter, persist it, and reload the
// folder. The choice is remembered per account (and separately for the unified
// inbox), so switching accounts restores that account's last filter.
export async function toggleUnreadFilter(): Promise<void> {
  const store = useMailStore.getState()
  const key = filterKeyForFolder(store.selectedFolderId)
  const next = !(store.unreadFilterByAccount[key] ?? false)
  const unreadFilterByAccount = { ...store.unreadFilterByAccount, [key]: next }
  store.setUnreadFilterByAccount(unreadFilterByAccount)
  scheduleSaveUiPreferences({ unreadFilterByAccount })

  // Clear selection + list backings so the switch doesn't show stale rows.
  store.setReaderError(null)
  store.setSelectedThreadId(null)
  store.setSelectedThread(null)
  store.setSelectedThreadKeys([])
  store.setThreadAnchorKey(null)
  store.setSelectedMessageId(null)
  store.setSelectedMessage(null)
  store.setSelectedMessageIds([])
  store.setExpandedThreadKeys([])
  store.setExpandedThreadMessages({})
  store.setThreads([])
  store.setThreadTotal(0)
  store.setThreadOffset(0)
  store.setMessages([])
  store.setMessageTotal(0)
  store.setMessageOffset(0)

  store.setListLoading(true)
  try {
    await loadFolderList(store.selectedFolderId, 0)
  } finally {
    store.setListLoading(false)
  }
}

function expandKey(accountId: string, threadId: string): string {
  return `${accountId} ${threadId}`
}

// Expand/collapse a thread's messages inline in the list. On expand, the
// conversation is fetched (across folders) and cached; collapse just hides it.
export async function toggleThreadExpanded(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  const key = expandKey(accountId, threadId)
  const isExpanded = store.expandedThreadKeys.includes(key)

  if (isExpanded) {
    store.setExpandedThreadKeys(store.expandedThreadKeys.filter((k) => k !== key))
    return
  }

  store.setExpandedThreadKeys([...store.expandedThreadKeys, key])
  if (store.expandedThreadMessages[key]) return // already cached

  try {
    const messages = await window.orbitMail.messages.getThread(accountId, threadId)
    const after = useMailStore.getState()
    if (!after.expandedThreadKeys.includes(key)) return // collapsed while loading
    after.setExpandedThreadMessages({ ...after.expandedThreadMessages, [key]: messages })
  } catch {
    // Leave it expanded but uncached; the row shows a loading state and a retry
    // happens on the next expand.
    const after = useMailStore.getState()
    after.setExpandedThreadKeys(after.expandedThreadKeys.filter((k) => k !== key))
  }
}

// Open a conversation: load every message in the thread (across folders), show
// the newest, and mark any unread messages read optimistically + in the
// background. `selectedThread` drives the reader.
// The folder list, read from *current* state rather than a snapshot taken before
// an await. Every mutation needs it, and they all reached for `store.folders`
// captured at the top of the function — which by then could predate the initial
// load, sending them to IPC for a list already in memory, or predate a rename.
// State read after an await must be re-read.
async function currentFolders(): Promise<Folder[]> {
  const { folders } = useMailStore.getState()
  return folders.length ? folders : await window.orbitMail.folders.list()
}

export async function selectThread(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  // A plain click collapses any multi-selection down to this one row.
  store.setSelectedThreadKeys([expandKey(accountId, threadId)])
  store.setThreadAnchorKey(expandKey(accountId, threadId))
  store.setSelectedThreadId(threadId)
  store.setSelectedThread(null)
  store.setThreadLoading(true)
  store.setReaderError(null)
  // Clear any single-message (search) selection so the reader shows the thread.
  store.setSelectedMessageId(null)
  store.setSelectedMessage(null)
  store.setSelectedMessageIds([])

  let messages: MessageDetail[]
  try {
    messages = await window.orbitMail.messages.getThread(accountId, threadId)
  } catch (err) {
    // Leave the row selected and offer a retry rather than stranding the pane on
    // "Loading conversation…" — this used to reject into a `void` call, so the
    // spinner stayed up and nothing said why.
    const failed = useMailStore.getState()
    if (failed.selectedThreadId !== threadId) return
    failed.setThreadLoading(false)
    failed.setReaderError({
      message: err instanceof Error ? err.message : 'Could not open this conversation',
      retry: { kind: 'thread', accountId, threadId }
    })
    return
  }

  const after = useMailStore.getState()
  if (after.selectedThreadId !== threadId) return // user moved on
  after.setSelectedThread(messages)
  after.setThreadLoading(false)

  // Optimistically clear the thread's unread dot in the list.
  markThreadReadInList(accountId, threadId)

  const unread = messages.filter((m) => !m.isRead)
  if (unread.length > 0) {
    try {
      await Promise.all(unread.map((m) => window.orbitMail.messages.markRead(m.id, true)))
      await refreshFoldersUnread()
    } catch {
      // best-effort; the next sync reconciles read state
    }
  }
}

// Update a thread row's aggregate unread/star after a per-message change.
function recomputeThreadAggregate(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  const thread = store.selectedThread
  if (!thread) return
  const hasUnread = thread.some((m) => !m.isRead)
  const isStarred = thread.some((m) => m.isStarred)
  store.setThreads(
    store.threads.map((t) =>
      t.threadId === threadId && t.accountId === accountId ? { ...t, hasUnread, isStarred } : t
    )
  )
}

function markThreadReadInList(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  store.setThreads(
    store.threads.map((t) =>
      t.threadId === threadId && t.accountId === accountId ? { ...t, hasUnread: false } : t
    )
  )
}

// Optimistically patch one message inside the open thread (read/star/flag) and
// refresh the list aggregate. Returns the prior fields for rollback.
export function patchThreadMessage(
  messageId: string,
  partial: Partial<MessageDetail>
): Partial<MessageDetail> | null {
  const store = useMailStore.getState()
  const thread = store.selectedThread
  if (!thread) return null
  const target = thread.find((m) => m.id === messageId)
  if (!target) return null

  const before: Partial<MessageDetail> = {}
  for (const key of Object.keys(partial) as (keyof MessageDetail)[]) {
    ;(before as Record<string, unknown>)[key] = target[key]
  }
  store.setSelectedThread(
    thread.map((m) => (m.id === messageId ? { ...m, ...partial } : m))
  )
  if (store.selectedThreadId) {
    recomputeThreadAggregate(target.accountId, store.selectedThreadId)
  }
  return before
}

// Shift-click: select every conversation between the anchor and this row. The
// flat list has had this since multi-select landed; conversation rows went
// straight to selectThread, so bulk actions were impossible in the default view.
export function selectThreadRange(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  const list = store.threads
  const key = expandKey(accountId, threadId)
  // Anchor: the stored one, else the row currently leading, else this row.
  const lead = list.find((t) => t.threadId === store.selectedThreadId)
  const anchor = store.threadAnchorKey ?? (lead ? threadKey(lead) : key)

  const fromIndex = list.findIndex((t) => threadKey(t) === anchor)
  const toIndex = list.findIndex((t) => threadKey(t) === key)
  if (fromIndex === -1 || toIndex === -1) {
    void selectThread(accountId, threadId)
    return
  }

  const [lo, hi] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
  const keys = list.slice(lo, hi + 1).map(threadKey)
  if (keys.length <= 1) {
    void selectThread(accountId, threadId)
    return
  }

  // The clicked row leads: it drives the reader, the rest stay highlighted. The
  // anchor is re-applied after, because selectThread moves it to the lead row —
  // which would make the next shift-click measure from the wrong end and the
  // range could never be shrunk back.
  void selectThreadKeepingSelection(accountId, threadId, keys, anchor)
  store.setThreadAnchorKey(anchor)
}

// Ctrl/Cmd-click: add or remove one conversation without disturbing the rest.
export function toggleThreadSelection(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  const key = expandKey(accountId, threadId)
  const current = store.selectedThreadKeys.length
    ? store.selectedThreadKeys
    : store.selectedThreadId
      ? store.threads.filter((t) => t.threadId === store.selectedThreadId).map(threadKey)
      : []

  if (current.includes(key)) {
    const next = current.filter((k) => k !== key)
    store.setSelectedThreadKeys(next)
    if (next.length === 0) {
      store.setSelectedThreadId(null)
      store.setSelectedThread(null)
      store.setThreadAnchorKey(null)
    } else if (store.selectedThreadId === threadId) {
      // The lead row left the selection; hand the reader to another member.
      const lead = store.threads.find((t) => next.includes(threadKey(t)))
      if (lead) void selectThreadKeepingSelection(lead.accountId, lead.threadId, next)
    }
    return
  }

  const next = [...current, key]
  store.setSelectedThreadKeys(next)
  store.setThreadAnchorKey(key)
  void selectThreadKeepingSelection(accountId, threadId, next)
}

// selectThread collapses the selection by design; ctrl-click needs the opposite.
async function selectThreadKeepingSelection(
  accountId: string,
  threadId: string,
  keys: string[],
  anchorKey?: string
): Promise<void> {
  await selectThread(accountId, threadId)
  // selectThread awaits the conversation fetch, so a second click can land while
  // this one is in flight. Re-applying the keys unconditionally would resurrect
  // the superseded selection — only restore them if this click still leads.
  const after = useMailStore.getState()
  if (after.selectedThreadId !== threadId) return
  after.setSelectedThreadKeys(keys)
  if (anchorKey) after.setThreadAnchorKey(anchorKey)
}

// Delete every selected conversation in one batch — the same server call the
// single-thread delete uses, with all the rows resolved up front.
type RelocateItem = { id: string; targetFolderId: string | null }

// Shared spine for the bulk conversation actions. They differ only in where each
// message goes and what the toast says: delete sends messages to Trash (or
// deletes them outright when already there), archive and move send them to a
// named folder. Everything else — resolving the conversations, dropping the rows
// optimistically, advancing past the run, holding the rows out of a refresh
// until the server answers — is identical.
async function relocateSelectedThreads(options: {
  // Where a message goes: a folder id, null to delete it, or undefined to leave
  // it where it is (already in the destination, or no such folder).
  destination: (message: MessageDetail, folders: Folder[]) => string | null | undefined
  toast: (threadCount: number) => string
  nothingToDo?: string
  failure: string
  invoke: (items: RelocateItem[]) => Promise<unknown>
  // Falls back to the single-conversation action when only one row is selected,
  // so the plain path keeps its own toasts and behaviour.
  single: (accountId: string, threadId: string) => Promise<void>
}): Promise<void> {
  const store = useMailStore.getState()
  const keys = store.selectedThreadKeys

  if (keys.length <= 1) {
    const key = keys[0]
    if (key) {
      const [accountId, threadId] = key.split(' ')
      await options.single(accountId, threadId)
      return
    }
    const row = store.threads.find((t) => t.threadId === store.selectedThreadId)
    if (row) await options.single(row.accountId, row.threadId)
    return
  }

  const selected = store.threads.filter((t) => keys.includes(threadKey(t)))
  if (selected.length === 0) return

  const folders = await currentFolders()
  const threads = await Promise.all(
    selected.map((t) => resolveThreadMessages(t.accountId, t.threadId))
  )
  const messages = threads.flat()

  const items: RelocateItem[] = []
  for (const m of messages) {
    const target = options.destination(m, folders)
    if (target === undefined) continue
    items.push({ id: m.id, targetFolderId: target })
  }
  if (items.length === 0) {
    if (options.nothingToDo) store.setToast(options.nothingToDo)
    return
  }

  // Advance past the whole run: the successor of the last selected row.
  const last = selected[selected.length - 1]
  const next = successorThread(last.accountId, last.threadId)
  for (const t of selected) removeThreadFromList(t.accountId, t.threadId)
  store.setSelectedThreadKeys([])
  store.setThreadAnchorKey(null)
  if (next && !keys.includes(threadKey(next))) {
    void selectThread(next.accountId, next.threadId)
  } else {
    store.setSelectedThread(null)
    store.setSelectedThreadId(null)
  }
  store.setToast(options.toast(selected.length))

  try {
    await withPendingRemoval(
      items.map((i) => i.id),
      keys,
      () => options.invoke(items)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : options.failure)
    await refreshMessages()
  }
}

export async function deleteSelectedThreads(): Promise<void> {
  await relocateSelectedThreads({
    destination: (m, folders) => {
      const currentFolder = folders.find((f) => f.id === m.folderId)
      if (currentFolder?.type === 'trash') return null
      return findAccountFolder(folders, m.accountId, 'trash')?.id ?? null
    },
    toast: (n) => `Deleted ${n} conversations`,
    failure: 'Delete failed',
    invoke: (items) => window.orbitMail.messages.deleteMany(items),
    single: deleteThread
  })
}

export async function archiveSelectedThreads(): Promise<void> {
  await relocateSelectedThreads({
    // A message already in the archive stays put rather than failing the batch.
    destination: (m, folders) => {
      const archive = findArchiveFolder(folders, m.accountId)
      if (!archive || m.folderId === archive.id) return undefined
      return archive.id
    },
    toast: (n) => `Archived ${n} conversations`,
    nothingToDo: 'No archive folder found for these accounts',
    failure: 'Archive failed',
    invoke: (items) => window.orbitMail.messages.moveMany(items),
    single: archiveThread
  })
}

export async function moveSelectedThreadsToFolder(targetFolderId: string): Promise<void> {
  const store = useMailStore.getState()
  const target = store.folders.find((f) => f.id === targetFolderId)
  await relocateSelectedThreads({
    destination: (m) => (m.folderId === targetFolderId ? undefined : targetFolderId),
    toast: (n) => `${n} conversations moved to ${target?.name ?? 'folder'}`,
    nothingToDo: `Already in ${target?.name ?? 'that folder'}`,
    failure: 'Move failed',
    invoke: (items) => window.orbitMail.messages.moveMany(items),
    single: (accountId, threadId) => moveThreadToFolder(accountId, threadId, targetFolderId)
  })
}

export function selectAdjacentThread(direction: 1 | -1): void {
  const store = useMailStore.getState()
  const list = store.threads
  if (list.length === 0) return
  const idx = list.findIndex((t) => t.threadId === store.selectedThreadId)
  const nextIdx = idx === -1 ? (direction === 1 ? 0 : list.length - 1) : idx + direction
  if (nextIdx < 0 || nextIdx >= list.length) return
  const t = list[nextIdx]
  void selectThread(t.accountId, t.threadId)
}

function removeThreadFromList(accountId: string, threadId: string): void {
  const store = useMailStore.getState()
  const next = store.threads.filter(
    (t) => !(t.threadId === threadId && t.accountId === accountId)
  )
  const removed = store.threads.length - next.length
  store.setThreads(next)
  if (removed > 0) store.setThreadTotal(Math.max(0, store.threadTotal - removed))
}

// Move an entire conversation to Trash (or delete when already there) via the
// batch endpoint. Optimistically drops the thread from the list.
export async function deleteThread(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  const messages =
    store.selectedThreadId === threadId && store.selectedThread
      ? store.selectedThread
      : await window.orbitMail.messages.getThread(accountId, threadId)
  if (messages.length === 0) return

  const folders = await currentFolders()
  const items = messages.map((m) => {
    const currentFolder = folders.find((f) => f.id === m.folderId)
    const trash =
      currentFolder?.type === 'trash' ? null : findAccountFolder(folders, m.accountId, 'trash')
    return { id: m.id, targetFolderId: trash?.id ?? null }
  })

  removeThreadAndAdvance(accountId, threadId)
  store.setToast(messages.length === 1 ? 'Deleted' : `Deleted ${messages.length} messages`)

  try {
    await withPendingRemoval(
      items.map((i) => i.id),
      [expandKey(accountId, threadId)],
      () => window.orbitMail.messages.deleteMany(items)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Delete failed')
    await refreshMessages()
  }
}

// Resolve a thread's messages: reuse the open thread when it's the one asked
// for, otherwise pull it fresh (mirrors deleteThread's resolution).
async function resolveThreadMessages(
  accountId: string,
  threadId: string
): Promise<MessageDetail[]> {
  const store = useMailStore.getState()
  return store.selectedThreadId === threadId && store.selectedThread
    ? store.selectedThread
    : await window.orbitMail.messages.getThread(accountId, threadId)
}

// Patch a single thread row in the list (aggregate read/star/flag).
function patchThreadRow(
  accountId: string,
  threadId: string,
  partial: Partial<ThreadSummary>
): void {
  const store = useMailStore.getState()
  store.setThreads(
    store.threads.map((t) =>
      t.threadId === threadId && t.accountId === accountId ? { ...t, ...partial } : t
    )
  )
}

// Archive every message in a conversation to its account's archive folder.
// Optimistically drops the thread from the list. Cross-folder, like deleteThread.
export async function archiveThread(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  if (messages.length === 0) return

  const folders = await currentFolders()
  const moves = messages
    .map((m) => {
      const archive = findArchiveFolder(folders, m.accountId)
      if (!archive || m.folderId === archive.id) return null
      return { id: m.id, targetFolderId: archive.id }
    })
    .filter((mv): mv is { id: string; targetFolderId: string } => mv !== null)

  if (moves.length === 0) {
    store.setToast('No archive folder found for this account')
    return
  }

  removeThreadAndAdvance(accountId, threadId)
  store.setToast(moves.length === 1 ? 'Message archived' : `Archived ${moves.length} messages`)

  try {
    await withPendingRemoval(
      moves.map((mv) => mv.id),
      [expandKey(accountId, threadId)],
      () =>
        Promise.all(moves.map((mv) => window.orbitMail.messages.move(mv.id, mv.targetFolderId)))
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Archive failed')
    await refreshMessages()
  }
}

export async function markThreadRead(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  const targets = messages.filter((m) => !m.isRead)

  markThreadReadInList(accountId, threadId)
  if (store.selectedThreadId === threadId && store.selectedThread) {
    store.setSelectedThread(store.selectedThread.map((m) => ({ ...m, isRead: true })))
  }
  if (targets.length === 0) return

  try {
    await Promise.all(targets.map((m) => window.orbitMail.messages.markRead(m.id, true)))
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Update failed')
    await refreshMessages()
  }
}

export async function markThreadUnread(accountId: string, threadId: string): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  const targets = messages.filter((m) => m.isRead)

  patchThreadRow(accountId, threadId, { hasUnread: true })
  if (store.selectedThreadId === threadId && store.selectedThread) {
    store.setSelectedThread(store.selectedThread.map((m) => ({ ...m, isRead: false })))
  }
  if (targets.length === 0) return

  try {
    await Promise.all(targets.map((m) => window.orbitMail.messages.markRead(m.id, false)))
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Update failed')
    await refreshMessages()
  }
}

export async function setThreadFlagColor(
  accountId: string,
  threadId: string,
  flagColor: FlagColor | null
): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  if (messages.length === 0) return

  // Mirror the DB rule: any flag colour implies starred; clearing it unstars.
  patchThreadRow(accountId, threadId, { flagColor, isStarred: flagColor !== null })
  if (store.selectedThreadId === threadId && store.selectedThread) {
    store.setSelectedThread(
      store.selectedThread.map((m) => ({ ...m, flagColor, isStarred: flagColor !== null }))
    )
  }

  try {
    await Promise.all(messages.map((m) => window.orbitMail.messages.setFlag(m.id, flagColor)))
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Update failed')
    await refreshMessages()
  }
}

export async function moveThreadToFolder(
  accountId: string,
  threadId: string,
  targetFolderId: string
): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  if (messages.length === 0) return

  const folders = await currentFolders()
  const target = folders.find((f) => f.id === targetFolderId)

  removeThreadAndAdvance(accountId, threadId)
  store.setToast(
    messages.length === 1
      ? `Message moved to ${target?.name ?? 'folder'}`
      : `${messages.length} messages moved to ${target?.name ?? 'folder'}`
  )

  try {
    await withPendingRemoval(
      messages.map((m) => m.id),
      [expandKey(accountId, threadId)],
      () => Promise.all(messages.map((m) => window.orbitMail.messages.move(m.id, targetFolderId)))
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Move failed')
    await refreshMessages()
  }
}

export async function copyThreadToFolder(
  accountId: string,
  threadId: string,
  targetFolderId: string
): Promise<void> {
  const store = useMailStore.getState()
  const messages = await resolveThreadMessages(accountId, threadId)
  if (messages.length === 0) return

  const folders = await currentFolders()
  const target = folders.find((f) => f.id === targetFolderId)

  try {
    await Promise.all(messages.map((m) => window.orbitMail.messages.copy(m.id, targetFolderId)))
    store.setToast(
      messages.length === 1
        ? `Message copied to ${target?.name ?? 'folder'}`
        : `${messages.length} messages copied to ${target?.name ?? 'folder'}`
    )
    await refreshMessages()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Copy failed')
  }
}

export async function toggleThreadMessageStar(
  messageId: string,
  isStarred: boolean
): Promise<void> {
  const store = useMailStore.getState()
  const before = patchThreadMessage(
    messageId,
    isStarred ? { isStarred: true } : { isStarred: false, flagColor: null }
  )
  try {
    await window.orbitMail.messages.toggleStar(messageId, isStarred)
  } catch (err) {
    if (before) patchThreadMessage(messageId, before)
    store.setToast(err instanceof Error ? err.message : 'Update failed')
  }
}

let refreshMessagesTimer: ReturnType<typeof setTimeout> | null = null

export function cancelScheduledRefreshMessages(): void {
  if (refreshMessagesTimer) {
    clearTimeout(refreshMessagesTimer)
    refreshMessagesTimer = null
  }
}

/** Debounced refresh for background sync (IDLE / polling). Avoids list flicker. */
export function scheduleRefreshMessages(delayMs?: number): void {
  const state = useMailStore.getState()
  const resolvedDelay =
    delayMs ?? (state.threads.length === 0 && state.messages.length === 0 ? 0 : 400)
  cancelScheduledRefreshMessages()
  if (resolvedDelay === 0) {
    void refreshMessages()
    return
  }
  refreshMessagesTimer = setTimeout(() => {
    refreshMessagesTimer = null
    void refreshMessages()
  }, resolvedDelay)
}

/** Refresh the list when sync finishes (syncing true → false). */
export function subscribeSyncCompleteRefresh(): () => void {
  return useMailStore.subscribe((state, prevState) => {
    if (prevState.syncStatus.syncing && !state.syncStatus.syncing) {
      cancelScheduledRefreshMessages()
      void refreshMessages()
    }
  })
}

export async function loadInitialData(): Promise<void> {
  const store = useMailStore.getState()
  store.setLoading(true)
  try {
    await loadPersistedPreferences()
    const persisted = useMailStore.getState()

    const [accounts, folders, syncStatus] = await Promise.all([
      window.orbitMail.accounts.list(),
      window.orbitMail.folders.list(),
      window.orbitMail.sync.getStatus()
    ])

    store.setAccounts(accounts)
    store.setFolders(folders)
    store.setSyncStatus(syncStatus)
    store.setThreadOffset(0)
    store.setMessageOffset(0)
    await loadFolderList(persisted.selectedFolderId, 0)

    if (accounts.length === 0) {
      store.setShowAddAccount(true)
    }
  } finally {
    store.setLoading(false)
  }
}

// Background refresh of the current folder's list (non-search) + folders.
export async function refreshMessages(): Promise<void> {
  const store = useMailStore.getState()
  const folderId = store.selectedFolderId
  await Promise.all([
    loadFolderList(folderId, 0),
    window.orbitMail.folders.list().then((folders) => useMailStore.getState().setFolders(folders))
  ])
  // Refresh any inline-expanded conversations so newly-arrived replies appear.
  const after = useMailStore.getState()
  if (after.expandedThreadKeys.length > 0) {
    const updated: Record<string, MessageDetail[]> = { ...after.expandedThreadMessages }
    await Promise.all(
      after.expandedThreadKeys.map(async (key) => {
        const [accountId, threadId] = key.split(' ')
        if (!accountId || !threadId) return
        updated[key] = await window.orbitMail.messages.getThread(accountId, threadId)
      })
    )
    useMailStore.getState().setExpandedThreadMessages(updated)
  }
}

export async function loadMoreMessages(): Promise<void> {
  const store = useMailStore.getState()
  if (store.threadedView) {
    if (store.threads.length >= store.threadTotal) return
    await loadFolderThreads(store.selectedFolderId, store.threadOffset)
  } else {
    if (store.messages.length >= store.messageTotal) return
    await loadFolderMessages(store.selectedFolderId, store.messageOffset)
  }
}

export async function addAccount(provider: 'gmail' | 'o365'): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.add(provider)
    // Auth and save are done; show the account and close the dialog now. The
    // first sync runs in the background (see accounts:add in main.ts) and its
    // folders fill in underneath as they arrive — App.tsx reloads the folder
    // tree on each sync:messagesUpdated. Waiting for the whole sync here is what
    // used to hold the dialog open for the full initial fetch.
    store.setShowAddAccount(false)
    store.setToast('Account added — syncing…')
    store.expandAccount(account.id)
    await loadInitialData()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to add account')
  }
}

export async function addManualAccount(input: ManualAccountInput): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.addManual(input)
    // Same as addAccount: show it and close the dialog now; the background sync
    // fills the folders in underneath.
    store.setShowAddAccount(false)
    store.setToast('Account added — syncing…')
    store.expandAccount(account.id)
    await loadInitialData()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to add account')
    throw err
  }
}

export async function removeAccountById(accountId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    await window.orbitMail.accounts.remove(accountId)
    store.setToast('Account removed')
    await loadInitialData()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to remove account')
  }
}

export async function syncAccountById(accountId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    await window.orbitMail.sync.refresh(accountId)
    store.setToast('Account synced')
    await refreshMessages()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Sync failed')
  }
}

export async function createMailboxForAccount(accountId: string, name: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    await window.orbitMail.folders.create(accountId, name)
    const folders = await window.orbitMail.folders.list()
    store.setFolders(folders)
    store.setToast(`Created mailbox “${name.trim()}”`)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to create mailbox')
    throw err
  }
}

export async function exportMailbox(folderId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    const exported = await window.orbitMail.folders.export(folderId)
    if (exported < 0) return
    store.setToast(
      exported === 0 ? 'Mailbox exported (no messages)' : `Exported ${exported} messages`
    )
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Export failed')
  }
}

export async function emptyTrashForAccount(accountId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    const count = await window.orbitMail.folders.emptyTrash(accountId)
    await refreshMessages()
    store.setToast(count === 0 ? 'Trash is already empty' : `Erased ${count} deleted items`)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to erase deleted items')
  }
}

export async function emptyJunkForAccount(accountId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    const count = await window.orbitMail.folders.emptyJunk(accountId)
    await refreshMessages()
    store.setToast(count === 0 ? 'Junk is already empty' : `Erased ${count} junk messages`)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to erase junk mail')
  }
}

export async function markAllReadInFolder(folderId: string): Promise<void> {
  const store = useMailStore.getState()
  try {
    const count = await window.orbitMail.folders.markAllRead(folderId)
    await refreshMessages()
    store.setToast(count === 0 ? 'All messages already read' : `Marked ${count} messages as read`)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to mark messages as read')
  }
}

export async function updateAccountDisplayName(
  accountId: string,
  displayName: string
): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.updateDisplayName(accountId, displayName)
    store.setAccounts(store.accounts.map((a) => (a.id === accountId ? account : a)))
    store.setToast('Account updated')
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to update account')
    throw err
  }
}

export async function updateAccountSyncDays(
  accountId: string,
  syncDays: number
): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.updateSyncDays(accountId, syncDays)
    store.setAccounts(store.accounts.map((a) => (a.id === accountId ? account : a)))
    store.setToast('Sync window updated')
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to update sync window')
    throw err
  }
}

function displayedMessages(store: MailState): MessageSummary[] {
  return store.searchQuery.trim().length > 0 ? store.searchResults : store.messages
}

function rangeIds(list: MessageSummary[], fromId: string, toId: string): string[] {
  const fromIndex = list.findIndex((m) => m.id === fromId)
  const toIndex = list.findIndex((m) => m.id === toId)
  if (fromIndex === -1 || toIndex === -1) return [toId]
  const [lo, hi] = fromIndex <= toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex]
  return list.slice(lo, hi + 1).map((m) => m.id)
}

// Make `messageId` the single, active selection: load it into the reader and
// mark it read. This is the plain click / plain arrow behaviour.
//
// The reader header paints immediately from the MessageSummary already in the
// list; only the body waits on messages.get. The unread dot flips optimistically
// and the read is confirmed to the server in the background (rolled back on
// failure) rather than blocking on a full list refresh.
export async function selectMessage(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  // Selecting a single message (e.g. a search result) supersedes any open thread.
  store.setSelectedThreadId(null)
  store.setSelectedThread(null)
  store.setSelectedThreadKeys([])
  store.setThreadAnchorKey(null)
  store.setSelectedMessageId(messageId)
  store.setSelectedMessageIds([messageId])
  store.setSelectionAnchorId(messageId)
  store.setReaderError(null)
  scheduleSaveUiPreferences({ selectedMessageId: messageId })

  const summary =
    store.messages.find((m) => m.id === messageId) ??
    store.searchResults.find((m) => m.id === messageId) ??
    Object.values(store.expandedThreadMessages)
      .flat()
      .find((m) => m.id === messageId)
  const wasUnread = summary ? !summary.isRead : false

  if (summary) {
    // Lightweight placeholder so the header renders synchronously; the body
    // arrives from messages.get a moment later.
    store.setSelectedMessage({
      ...summary,
      isRead: true,
      cc: '',
      references: null,
      bodyHtml: null,
      bodyText: null,
      attachments: []
    })
    store.setReaderLoading(true)
  } else {
    store.setSelectedMessage(null)
  }

  if (wasUnread) patchMessageInList(messageId, { isRead: true })

  let msg: MessageDetail | null
  try {
    msg = await window.orbitMail.messages.get(messageId)
  } catch (err) {
    const failed = useMailStore.getState()
    if (failed.selectedMessageId !== messageId) return
    failed.setReaderLoading(false)
    failed.setReaderError({
      message: err instanceof Error ? err.message : 'Could not open this message',
      retry: { kind: 'message', messageId }
    })
    return
  }

  const afterGet = useMailStore.getState()
  // Only apply the body if this is still the active selection.
  if (afterGet.selectedMessageId === messageId) {
    afterGet.setSelectedMessage(msg ? { ...msg, isRead: msg.isRead || wasUnread } : null)
    afterGet.setReaderLoading(false)
  }

  // Surface any persisted AI summary (cached-only — no API call) so the reader
  // shows it on open and "Print with AI summary" is offered. Fire-and-forget;
  // only applies if this is still the selection and nothing is already loaded.
  if (msg && !afterGet.aiAnalysisById[messageId]) {
    void window.orbitMail.ai
      .getCachedAnalysis(messageId)
      .then((analysis) => {
        const s = useMailStore.getState()
        if (analysis && s.selectedMessageId === messageId && !s.aiAnalysisById[messageId]) {
          s.setAiAnalysis(messageId, analysis)
        }
      })
      .catch(() => {})
  }

  if (msg && wasUnread) {
    try {
      await window.orbitMail.messages.markRead(messageId, true)
      await refreshFoldersUnread()
    } catch {
      patchMessageInList(messageId, { isRead: false })
    }
  }
}

// Add/remove a message from the selection (Ctrl/Cmd+click). When the selection
// collapses to one message it behaves like a plain selection.
export async function toggleMessageSelection(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const current = store.selectedMessageIds
  const isSelected = current.includes(messageId)
  const nextIds = isSelected
    ? current.filter((id) => id !== messageId)
    : [...current, messageId]

  if (nextIds.length === 0) {
    store.setSelectedMessageIds([])
    store.setSelectedMessageId(null)
    store.setSelectedMessage(null)
    store.setSelectionAnchorId(null)
    scheduleSaveUiPreferences({ selectedMessageId: null })
    return
  }

  if (nextIds.length === 1) {
    await selectMessage(nextIds[0])
    return
  }

  // Multiple messages remain selected: keep a lead but show the count in the
  // reader rather than loading a body. Removing a non-lead row keeps the
  // current lead; removing the lead itself falls back to the last row.
  const leadId = !isSelected
    ? messageId
    : messageId === store.selectedMessageId
      ? nextIds[nextIds.length - 1]
      : store.selectedMessageId ?? nextIds[nextIds.length - 1]
  store.setSelectedMessageIds(nextIds)
  store.setSelectedMessageId(leadId)
  store.setSelectedMessage(null)
  store.setSelectionAnchorId(messageId)
  scheduleSaveUiPreferences({ selectedMessageId: leadId })
}

// Select the contiguous range between the current anchor and `messageId`
// (Shift+click).
// Re-run whichever open failed. The reader's Retry button calls this, so the
// component never has to know whether a conversation or a message was pending.
export async function retryReaderLoad(): Promise<void> {
  const { readerError } = useMailStore.getState()
  if (!readerError) return
  if (readerError.retry.kind === 'thread') {
    await selectThread(readerError.retry.accountId, readerError.retry.threadId)
  } else {
    await selectMessage(readerError.retry.messageId)
  }
}

export async function selectMessageRange(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const list = displayedMessages(store)
  const anchor = store.selectionAnchorId ?? store.selectedMessageId ?? messageId
  const ids = rangeIds(list, anchor, messageId)

  if (ids.length <= 1) {
    await selectMessage(messageId)
    return
  }

  store.setSelectedMessageIds(ids)
  store.setSelectedMessageId(messageId)
  store.setSelectedMessage(null)
  store.setSelectionAnchorId(anchor)
  scheduleSaveUiPreferences({ selectedMessageId: messageId })
}

export function selectAdjacentMessage(direction: 1 | -1): void {
  const store = useMailStore.getState()
  const list = displayedMessages(store)
  if (list.length === 0) return

  const currentIndex = list.findIndex((m) => m.id === store.selectedMessageId)
  const nextIndex =
    currentIndex === -1
      ? direction === 1
        ? 0
        : list.length - 1
      : currentIndex + direction

  if (nextIndex < 0 || nextIndex >= list.length) return
  void selectMessage(list[nextIndex].id)
}

// Extend the selection by moving the lead one row while keeping the anchor
// fixed (Shift+Arrow).
export function extendSelectionToAdjacent(direction: 1 | -1): void {
  const store = useMailStore.getState()
  const list = displayedMessages(store)
  if (list.length === 0) return

  const leadIndex = list.findIndex((m) => m.id === store.selectedMessageId)
  if (leadIndex === -1) {
    selectAdjacentMessage(direction)
    return
  }

  const nextIndex = leadIndex + direction
  if (nextIndex < 0 || nextIndex >= list.length) return

  const nextLeadId = list[nextIndex].id
  const anchor = store.selectionAnchorId ?? store.selectedMessageId ?? nextLeadId
  const ids = rangeIds(list, anchor, nextLeadId)

  if (ids.length <= 1) {
    void selectMessage(nextLeadId)
    return
  }

  store.setSelectedMessageIds(ids)
  store.setSelectedMessageId(nextLeadId)
  store.setSelectedMessage(null)
  store.setSelectionAnchorId(anchor)
  scheduleSaveUiPreferences({ selectedMessageId: nextLeadId })
}

export async function selectFolder(folderId: string | 'unified'): Promise<void> {
  const store = useMailStore.getState()
  store.setSelectedFolderId(folderId)
  store.setSelectedMessageId(null)
  store.setSelectedMessage(null)
  store.setSelectedMessageIds([])
  store.setSelectionAnchorId(null)
  store.setReaderError(null)
  store.setSelectedThreadId(null)
  store.setSelectedThread(null)
  store.setSelectedThreadKeys([])
  store.setThreadAnchorKey(null)
  store.setThreadOffset(0)
  store.setMessageOffset(0)
  store.setExpandedThreadKeys([])
  store.setExpandedThreadMessages({})
  store.setSearchQuery('')
  store.setSearchResults([])
  scheduleSaveUiPreferences({
    selectedFolderId: folderId,
    selectedMessageId: null
  })
  // Clear the previous folder's rows and show skeletons while the (fast, local)
  // query runs, so the switch doesn't flash the old folder's rows.
  store.setThreads([])
  store.setThreadTotal(0)
  store.setMessages([])
  store.setMessageTotal(0)
  store.setListLoading(true)
  try {
    await loadFolderList(folderId, 0)
  } finally {
    store.setListLoading(false)
  }
}

export async function moveMessageToTrash(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const msg = store.selectedMessage ?? (await window.orbitMail.messages.get(messageId))
  if (!msg) return

  const folders = await currentFolders()
  const currentFolder = folders.find((f) => f.id === msg.folderId)
  const alreadyInTrash = currentFolder?.type === 'trash'
  const trash = alreadyInTrash ? null : findAccountFolder(folders, msg.accountId, 'trash')

  // Optimistically remove from the list, move the selection on, and show
  // feedback immediately — the server move + re-poll can take a few seconds, so
  // we don't wait for them to confirm the UI.
  removeMessagesAndAdvance([messageId])
  store.setToast(
    trash ? `Moved to “${trash.name}”` : alreadyInTrash ? 'Deleted permanently' : 'Deleted'
  )

  try {
    await withPendingRemoval([messageId], [], () =>
      trash
        ? window.orbitMail.messages.move(messageId, trash.id)
        : window.orbitMail.messages.delete(messageId)
    )
  } catch (err) {
    // Server rejected the delete/move — restore the true state and report why.
    store.setToast(err instanceof Error ? err.message : 'Delete failed')
    await refreshMessages()
    return
  }
  await refreshFoldersUnread()
}

// Move every selected message to Trash (or delete when already in Trash).
export async function deleteSelectedMessages(): Promise<void> {
  const store = useMailStore.getState()
  const ids = store.selectedMessageIds.length
    ? store.selectedMessageIds
    : store.selectedMessageId
      ? [store.selectedMessageId]
      : []

  if (ids.length <= 1) {
    if (ids.length === 1) await moveMessageToTrash(ids[0])
    return
  }

  const folders = await currentFolders()

  // Resolve each message's destination (trash folder, or permanent delete when
  // already in trash) from the summaries we already have — no per-id server get.
  const summaries = new Map(
    [...store.messages, ...store.searchResults].map((m) => [m.id, m])
  )
  const items: { id: string; targetFolderId: string | null }[] = []
  const destinations: string[] = []
  for (const id of ids) {
    const msg = summaries.get(id)
    if (!msg) {
      items.push({ id, targetFolderId: null })
      continue
    }
    const currentFolder = folders.find((f) => f.id === msg.folderId)
    const trash =
      currentFolder?.type === 'trash' ? null : findAccountFolder(folders, msg.accountId, 'trash')
    const dest = trash ? trash.name : 'Trash'
    if (!destinations.includes(dest)) destinations.push(dest)
    items.push({ id, targetFolderId: trash?.id ?? null })
  }

  // Optimistically drop the rows and land on the next one before the server
  // round-trips.
  removeMessagesAndAdvance(ids)

  const label = destinations.length === 1 ? destinations[0] : 'Trash'
  try {
    const { deleted, failed } = await withPendingRemoval(ids, [], () =>
      window.orbitMail.messages.deleteMany(items)
    )
    store.setToast(
      failed > 0
        ? `${deleted} moved to ${label}, ${failed} failed`
        : `${deleted} moved to ${label}`
    )
    if (failed > 0) await refreshMessages()
    else await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Delete failed')
    await refreshMessages()
  }
}

// Flat-list counterpart of relocateSelectedThreads: archive or move every
// selected message in one batch, falling back to the single-message action when
// only one row is selected so its toasts and behaviour are unchanged.
async function relocateSelectedMessages(options: {
  destination: (message: MessageSummary, folders: Folder[]) => string | null | undefined
  toast: (count: number) => string
  nothingToDo?: string
  failure: string
  single: (messageId: string) => Promise<void>
}): Promise<void> {
  const store = useMailStore.getState()
  const ids = store.selectedMessageIds.length
    ? store.selectedMessageIds
    : store.selectedMessageId
      ? [store.selectedMessageId]
      : []

  if (ids.length <= 1) {
    if (ids.length === 1) await options.single(ids[0])
    return
  }

  const folders = await currentFolders()
  const summaries = new Map(
    [...store.messages, ...store.searchResults].map((m) => [m.id, m])
  )

  const items: RelocateItem[] = []
  for (const id of ids) {
    const msg = summaries.get(id)
    if (!msg) continue
    const target = options.destination(msg, folders)
    if (target === undefined) continue
    items.push({ id, targetFolderId: target })
  }
  if (items.length === 0) {
    if (options.nothingToDo) store.setToast(options.nothingToDo)
    return
  }

  removeMessagesAndAdvance(items.map((i) => i.id))
  store.setToast(options.toast(items.length))

  try {
    await withPendingRemoval(
      items.map((i) => i.id),
      [],
      () => window.orbitMail.messages.moveMany(items)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : options.failure)
    await refreshMessages()
  }
}

export async function archiveSelectedMessages(): Promise<void> {
  await relocateSelectedMessages({
    destination: (m, folders) => {
      const archive = findArchiveFolder(folders, m.accountId)
      if (!archive || m.folderId === archive.id) return undefined
      return archive.id
    },
    toast: (n) => `Archived ${n} messages`,
    nothingToDo: 'No archive folder found for these accounts',
    failure: 'Archive failed',
    single: archiveMessage
  })
}

export async function moveSelectedMessagesToFolder(targetFolderId: string): Promise<void> {
  const store = useMailStore.getState()
  const target = store.folders.find((f) => f.id === targetFolderId)
  await relocateSelectedMessages({
    destination: (m) => (m.folderId === targetFolderId ? undefined : targetFolderId),
    toast: (n) => `${n} messages moved to ${target?.name ?? 'folder'}`,
    nothingToDo: `Already in ${target?.name ?? 'that folder'}`,
    failure: 'Move failed',
    single: (messageId) => moveMessageToFolder(messageId, targetFolderId)
  })
}

export async function archiveMessage(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const msg = store.selectedMessage ?? (await window.orbitMail.messages.get(messageId))
  if (!msg) return

  const folders = await currentFolders()
  const archive = findArchiveFolder(folders, msg.accountId)

  if (!archive) {
    store.setToast('No archive folder found for this account')
    return
  }

  // Optimistically remove from the list + clear the reader, then move on the
  // server. The row is already gone locally; roll back on failure.
  removeMessagesAndAdvance([messageId])
  store.setToast('Message archived')

  try {
    await withPendingRemoval([messageId], [], () =>
      window.orbitMail.messages.move(messageId, archive.id)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Archive failed')
    await refreshMessages()
  }
}

export async function markMessageUnread(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const before = patchMessageInList(messageId, { isRead: false })
  try {
    await window.orbitMail.messages.markRead(messageId, false)
    await refreshFoldersUnread()
  } catch (err) {
    if (before) patchMessageInList(messageId, before)
    store.setToast(err instanceof Error ? err.message : 'Update failed')
  }
}

export async function markMessageRead(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const before = patchMessageInList(messageId, { isRead: true })
  try {
    await window.orbitMail.messages.markRead(messageId, true)
    await refreshFoldersUnread()
  } catch (err) {
    if (before) patchMessageInList(messageId, before)
    store.setToast(err instanceof Error ? err.message : 'Update failed')
  }
}

export async function moveMessageToJunk(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const msg = store.selectedMessage ?? (await window.orbitMail.messages.get(messageId))
  if (!msg) return

  const folders = await currentFolders()
  const junk = findAccountFolder(folders, msg.accountId, 'junk')

  if (!junk) {
    store.setToast('No junk folder found for this account')
    return
  }

  removeMessagesAndAdvance([messageId])
  store.setToast('Message moved to Junk')

  try {
    await withPendingRemoval([messageId], [], () =>
      window.orbitMail.messages.move(messageId, junk.id)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Move failed')
    await refreshMessages()
  }
}

export async function moveMessageToFolder(
  messageId: string,
  targetFolderId: string
): Promise<void> {
  const store = useMailStore.getState()
  const folders = await currentFolders()
  const target = folders.find((folder) => folder.id === targetFolderId)

  removeMessagesAndAdvance([messageId])
  store.setToast(`Message moved to ${target?.name ?? 'folder'}`)

  try {
    await withPendingRemoval([messageId], [], () =>
      window.orbitMail.messages.move(messageId, targetFolderId)
    )
    await refreshFoldersUnread()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Move failed')
    await refreshMessages()
  }
}

export async function copyMessageToFolder(
  messageId: string,
  targetFolderId: string
): Promise<void> {
  const store = useMailStore.getState()
  const folders = await currentFolders()
  const target = folders.find((folder) => folder.id === targetFolderId)

  await window.orbitMail.messages.copy(messageId, targetFolderId)
  store.setToast(`Message copied to ${target?.name ?? 'folder'}`)
  await refreshMessages()
}

export async function setMessageFlagColor(
  messageId: string,
  flagColor: FlagColor | null
): Promise<void> {
  const store = useMailStore.getState()
  // Mirror the DB rule: any flag colour implies starred; clearing it unstars.
  const before = patchMessageInList(messageId, { flagColor, isStarred: flagColor !== null })
  try {
    await window.orbitMail.messages.setFlag(messageId, flagColor)
  } catch (err) {
    if (before) patchMessageInList(messageId, before)
    store.setToast(err instanceof Error ? err.message : 'Update failed')
  }
}

export async function toggleMessageStar(messageId: string, isStarred: boolean): Promise<void> {
  const store = useMailStore.getState()
  // Unstarring also clears any flag colour (mirrors setMessageStarred in the DB).
  const before = patchMessageInList(
    messageId,
    isStarred ? { isStarred: true } : { isStarred: false, flagColor: null }
  )
  try {
    await window.orbitMail.messages.toggleStar(messageId, isStarred)
  } catch (err) {
    if (before) patchMessageInList(messageId, before)
    store.setToast(err instanceof Error ? err.message : 'Update failed')
  }
}

export { saveUiPreferencesNow } from './persistence'

export function clearSearch(): void {
  const store = useMailStore.getState()
  store.setSearchQuery('')
  store.setSearchResults([])
  store.setSearchLoading(false)
  store.setServerSearched(false)
}

export async function allowSenderImages(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return
  useMailStore.getState().addImageAllowedSender(normalized)
  await window.orbitMail.preferences.allowSenderImages(normalized)
}

export async function runSearch(
  query: string,
  accountId: string,
  field: SearchField = 'all'
): Promise<void> {
  const store = useMailStore.getState()
  store.setSearchQuery(query)
  store.setSearchField(field)
  store.setServerSearched(false)
  if (!query.trim()) {
    store.setSearchResults([])
    store.setSearchLoading(false)
    return
  }

  // A newer keystroke — or a scope change — started a different search while we
  // were awaiting.
  const isStale = () => {
    const s = useMailStore.getState()
    return s.searchQuery !== query || s.searchField !== field
  }

  const results = await window.orbitMail.search.query(query, accountId, field)
  if (isStale()) return
  store.setSearchResults(results)

  // If the local cache had nothing, auto-run the live server search. When there
  // ARE local hits we leave the server search to the explicit banner action —
  // a broad term (e.g. a sender name) often matches quoted bodies locally while
  // the message the user actually wants sits outside the synced window.
  if (results.length === 0) {
    await searchWholeMailbox(query, accountId)
  }
}

// Live "search the entire mailbox" on the server, merged into the current
// results (deduped by id, newest first). Reachable both as the empty-result
// fallback and as an explicit action from the search-results banner.
export async function searchWholeMailbox(query: string, accountId: string): Promise<void> {
  const store = useMailStore.getState()
  const q = query.trim()
  if (!q) return

  const field = useMailStore.getState().searchField
  const isStale = () => {
    const s = useMailStore.getState()
    return s.searchQuery !== q || s.searchField !== field
  }

  store.setSearchLoading(true)
  try {
    const serverResults = await window.orbitMail.search.server(q, accountId, field)
    if (isStale()) return

    const byId = new Map(useMailStore.getState().searchResults.map((m) => [m.id, m]))
    let added = 0
    for (const m of serverResults) {
      if (!byId.has(m.id)) added++
      byId.set(m.id, m)
    }
    const merged = [...byId.values()].sort((a, b) => b.date - a.date)
    store.setSearchResults(merged)
    store.setServerSearched(true)
    store.setToast(
      added === 0
        ? 'No new matches on the server'
        : added === 1
          ? 'Found 1 more on the server'
          : `Found ${added} more on the server`
    )
  } finally {
    if (!isStale()) store.setSearchLoading(false)
  }
}

// Request an AI analysis of a message and cache it in the store. Surfaces
// errors via toast (and opens AI settings when no key is configured).
export async function analyzeMessage(
  messageId: string,
  force = false,
  includeAttachments = false
): Promise<void> {
  const store = useMailStore.getState()
  if (store.aiAnalyzingId) return
  store.setAiAnalyzingId(messageId)
  try {
    const result = await window.orbitMail.ai.analyze(messageId, force, includeAttachments)
    if ('error' in result) {
      store.setToast(result.error)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    store.setAiAnalysis(messageId, result)
    const skipped = result.skippedAttachments
    if (skipped && skipped.length > 0) {
      const names = skipped.join(', ')
      store.setToast(
        skipped.length === 1
          ? `Couldn't include attachment: ${names}`
          : `Couldn't include ${skipped.length} attachments: ${names}`
      )
    }
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Analysis failed')
  } finally {
    store.setAiAnalyzingId(null)
  }
}

// Generate an AI reply draft in the chosen tone and open it in the composer.
// The draft becomes the new-message body; enrichComposePayload/buildReplyPayload
// fill To/Subject/quoted-thread/threading, and the quote stays collapsible.
export async function draftReply(
  messageId: string,
  tone: DraftTone,
  mode: 'reply' | 'reply-all' = 'reply'
): Promise<void> {
  const store = useMailStore.getState()
  if (store.draftingReplyId) return
  const accountId =
    store.selectedMessage?.id === messageId
      ? store.selectedMessage.accountId
      : store.messages.find((m) => m.id === messageId)?.accountId
  store.setDraftingReplyId(messageId)
  try {
    const result = await window.orbitMail.ai.draftReply(messageId, tone, mode)
    if ('error' in result) {
      store.setToast(result.error)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    await window.orbitMail.compose.open({
      accountId,
      mode,
      originalMessageId: messageId,
      bodyHtml: draftToHtml(result.bodyText),
      bodyText: result.bodyText
    })
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Could not draft a reply')
  } finally {
    store.setDraftingReplyId(null)
  }
}

// Open the Tasks digest and hydrate it from the last persisted sweep for the
// current folder — no API call, no tokens spent. The user chooses scope and
// runs a fresh sweep from inside the dialog.
export async function openTasksDialog(): Promise<void> {
  const store = useMailStore.getState()
  store.setShowTasks(true)
  try {
    const result = await window.orbitMail.ai.getTasks(store.selectedFolderId)
    store.setSweepResult(result.tasks, result.completed, result.analyzedCount, result.sweptAt)
    store.setSweepScope(result.scope)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Could not load tasks')
  }
}

// Run a fresh sweep of the current folder for outstanding tasks using the
// selected scope. Errors surface via toast (and open AI settings if no key).
export async function runSweep(scope?: SweepScope): Promise<void> {
  const store = useMailStore.getState()
  if (store.sweeping) return
  const useScope = scope ?? store.sweepScope
  if (scope) store.setSweepScope(scope)
  store.setShowTasks(true)
  store.setSweeping(true)
  try {
    const result = await window.orbitMail.ai.sweep(store.selectedFolderId, useScope)
    if ('error' in result) {
      store.setToast(result.error)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    store.setSweepResult(result.tasks, result.completed, result.analyzedCount, result.sweptAt)
    if (result.analyzedCount > 0) {
      store.setToast(
        result.freshCount === 0
          ? 'No new mail to analyze — reused cached results (no tokens spent).'
          : `Analyzed ${result.freshCount} new message${result.freshCount === 1 ? '' : 's'}.`
      )
    }
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Sweep failed')
  } finally {
    store.setSweeping(false)
  }
}

// Force one email into the current folder's task list. The model identifies the
// action; the task persists as a manual entry that future sweeps won't remove.
// Errors surface via toast (and open AI settings if no key is configured).
export async function flagMessageAsTask(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  if (store.flaggingTaskId) return
  store.setFlaggingTaskId(messageId)
  try {
    const result = await window.orbitMail.ai.flagAsTask(store.selectedFolderId, messageId)
    if ('error' in result) {
      store.setToast(result.error)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    store.setSweepResult(result.tasks, result.completed, result.analyzedCount, result.sweptAt)
    store.setToast('Added to AI tasks.')
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Could not flag this email')
  } finally {
    store.setFlaggingTaskId(null)
  }
}

// Export the current sweep (open + completed tasks) to a Markdown file the user
// chooses via a save dialog. No-op with a toast if there's nothing to export.
export async function exportTasks(): Promise<void> {
  const store = useMailStore.getState()
  if (store.sweepTasks.length === 0 && store.sweepCompleted.length === 0) {
    store.setToast('No tasks to export yet — run a sweep first.')
    return
  }
  const markdown = buildTasksMarkdown({
    tasks: store.sweepTasks,
    completed: store.sweepCompleted,
    scope: store.sweepScope,
    analyzedCount: store.sweepAnalyzedCount,
    sweptAt: store.sweepSweptAt
  })
  try {
    const savedPath = await window.orbitMail.ai.exportTasks(markdown, defaultTasksFilename())
    if (savedPath) store.setToast(`Tasks exported to ${savedPath.split('/').pop()}`)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Export failed')
  }
}

// Mark a task done (persisted) and move it into the completed list optimistically.
export async function completeTask(taskId: string): Promise<void> {
  const store = useMailStore.getState()
  const task = store.sweepTasks.find((t) => t.id === taskId)
  if (!task) return
  const completed: CompletedTask = { ...task, completedAt: Date.now() }
  store.setSweepResult(
    store.sweepTasks.filter((t) => t.id !== taskId),
    [completed, ...store.sweepCompleted],
    store.sweepAnalyzedCount,
    store.sweepSweptAt
  )
  try {
    await window.orbitMail.ai.completeTask(store.selectedFolderId, taskId)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Could not update task')
  }
}

// Undo a completion: move the task back to the open list (persisted).
export async function reopenTask(taskId: string): Promise<void> {
  const store = useMailStore.getState()
  const done = store.sweepCompleted.find((t) => t.id === taskId)
  if (!done) return
  const { completedAt: _completedAt, ...task } = done
  store.setSweepResult(
    [task, ...store.sweepTasks],
    store.sweepCompleted.filter((t) => t.id !== taskId),
    store.sweepAnalyzedCount,
    store.sweepSweptAt
  )
  try {
    await window.orbitMail.ai.reopenTask(store.selectedFolderId, taskId)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Could not update task')
  }
}
