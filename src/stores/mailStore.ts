import { create } from 'zustand'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  SyncStatus,
  ManualAccountInput,
  FlagColor,
  AiAnalysis,
  SweepTask,
  CompletedTask,
  SweepScope
} from '../../shared/types'
import {
  loadPersistedPreferences,
  scheduleSaveUiPreferences
} from './persistence'
import { findAccountFolder, findArchiveFolder } from '../utils/folders'
import { buildTasksMarkdown, defaultTasksFilename } from '../utils/taskExport'

export const MESSAGE_PAGE_SIZE = 200

interface MailState {
  accounts: Account[]
  folders: Folder[]
  messages: MessageSummary[]
  messageOffset: number
  messageTotal: number
  selectedMessageId: string | null
  selectedMessage: MessageDetail | null
  readerLoading: boolean
  selectedMessageIds: string[]
  selectionAnchorId: string | null
  selectedFolderId: string | 'unified'
  searchQuery: string
  searchResults: MessageSummary[]
  syncStatus: SyncStatus
  showAddAccount: boolean
  toast: string | null
  loading: boolean
  isOnline: boolean
  collapsedAccountIds: Record<string, boolean>
  favoriteFolderIds: string[]
  aiAnalysisById: Record<string, AiAnalysis>
  aiAnalyzingId: string | null
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
  setSelectedMessageId: (id: string | null) => void
  setSelectedMessage: (msg: MessageDetail | null) => void
  setReaderLoading: (loading: boolean) => void
  setSelectedMessageIds: (ids: string[]) => void
  setSelectionAnchorId: (id: string | null) => void
  setSelectedFolderId: (id: string | 'unified') => void
  setSearchQuery: (q: string) => void
  setSearchResults: (results: MessageSummary[]) => void
  setSyncStatus: (status: SyncStatus) => void
  setShowAddAccount: (show: boolean) => void
  setToast: (msg: string | null) => void
  setLoading: (loading: boolean) => void
  setIsOnline: (online: boolean) => void
  toggleAccountCollapsed: (accountId: string) => void
  expandAccount: (accountId: string) => void
  toggleFavoriteFolder: (folderId: string) => void
  setAiAnalysis: (messageId: string, analysis: AiAnalysis) => void
  setAiAnalyzingId: (id: string | null) => void
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
  selectedMessageId: null,
  selectedMessage: null,
  readerLoading: false,
  selectedMessageIds: [],
  selectionAnchorId: null,
  selectedFolderId: 'unified',
  searchQuery: '',
  searchResults: [],
  syncStatus: { syncing: false, lastSyncAt: null, error: null, syncCurrent: 0, syncTotal: 0 },
  showAddAccount: false,
  toast: null,
  loading: false,
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  collapsedAccountIds: {},
  favoriteFolderIds: [],
  aiAnalysisById: {},
  aiAnalyzingId: null,
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
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
  setReaderLoading: (loading) => set({ readerLoading: loading }),
  setSelectedMessageIds: (ids) => set({ selectedMessageIds: ids }),
  setSelectionAnchorId: (id) => set({ selectionAnchorId: id }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setShowAddAccount: (show) => set({ showAddAccount: show }),
  setToast: (msg) => set({ toast: msg }),
  setLoading: (loading) => set({ loading }),
  setIsOnline: (online) => set({ isOnline: online }),
  setAiAnalysis: (messageId, analysis) =>
    set((state) => ({ aiAnalysisById: { ...state.aiAnalysisById, [messageId]: analysis } })),
  setAiAnalyzingId: (id) => set({ aiAnalyzingId: id }),
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
    })
}))

function messageListSignature(messages: MessageSummary[]): string {
  return messages
    .map(
      (m) =>
        `${m.id}:${m.isRead ? 1 : 0}:${m.isStarred ? 1 : 0}:${m.flagColor ?? ''}:${m.date}`
    )
    .join('|')
}

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

// Optimistically patch a single row in the visible list (and search results, and
// the open reader if it matches) so a flag/read/star change shows instantly
// without re-fetching the page. Returns the prior values of the changed fields
// for the matched row so callers can roll back on IPC failure.
function patchMessageInList(
  id: string,
  partial: Partial<MessageSummary>
): Partial<MessageSummary> | null {
  const store = useMailStore.getState()
  const prev = store.messages.find((m) => m.id === id)
  const prevSearch = store.searchResults.find((m) => m.id === id)
  const source = prev ?? prevSearch
  if (!source) {
    // Row isn't in either list, but the reader may still be showing it.
    if (store.selectedMessage?.id === id) {
      store.setSelectedMessage({ ...store.selectedMessage, ...partial })
    }
    return null
  }

  const before: Partial<MessageSummary> = {}
  for (const key of Object.keys(partial) as (keyof MessageSummary)[]) {
    ;(before as Record<string, unknown>)[key] = source[key]
  }

  if (prev) {
    store.setMessages(store.messages.map((m) => (m.id === id ? { ...m, ...partial } : m)))
  }
  if (prevSearch) {
    store.setSearchResults(
      store.searchResults.map((m) => (m.id === id ? { ...m, ...partial } : m))
    )
  }
  if (store.selectedMessage?.id === id) {
    store.setSelectedMessage({ ...store.selectedMessage, ...partial })
  }
  return before
}

// Recompute a folder's unread badge locally from the current list so the sidebar
// count tracks an optimistic read/unread flip without a folders re-fetch.
async function refreshFoldersUnread(): Promise<void> {
  const folders = await window.orbitMail.folders.list()
  useMailStore.getState().setFolders(folders)
}

function shouldReplaceMessageList(
  current: MessageSummary[],
  next: MessageSummary[]
): boolean {
  if (next.length > 0 && current.length === 0) return true
  return messageListSignature(current) !== messageListSignature(next)
}

function applyMessagePage(
  messages: MessageSummary[],
  total: number,
  offset: number
): void {
  const store = useMailStore.getState()

  if (offset === 0) {
    if (shouldReplaceMessageList(store.messages, messages)) {
      store.setMessages(messages)
    }
  } else {
    store.appendMessages(messages)
  }
  store.setMessageOffset(offset + messages.length)
  if (store.messageTotal !== total) {
    store.setMessageTotal(total)
  }
}

async function loadFolderMessages(
  folderId: string | 'unified',
  offset = 0
): Promise<void> {
  const [messages, total] = await Promise.all([
    window.orbitMail.messages.list(folderId, MESSAGE_PAGE_SIZE, offset),
    window.orbitMail.messages.count(folderId)
  ])
  applyMessagePage(messages, total, offset)
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
  const resolvedDelay =
    delayMs ??
    (useMailStore.getState().messages.length === 0 ? 0 : 400)
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
    store.setMessageOffset(0)
    await loadFolderMessages(persisted.selectedFolderId, 0)

    if (persisted.selectedMessageId) {
      const msg = await window.orbitMail.messages.get(persisted.selectedMessageId)
      if (msg) {
        store.setSelectedMessageId(msg.id)
        store.setSelectedMessage(msg)
        store.setSelectedMessageIds([msg.id])
        store.setSelectionAnchorId(msg.id)
      } else {
        store.setSelectedMessageId(null)
        store.setSelectedMessage(null)
        scheduleSaveUiPreferences({ selectedMessageId: null })
      }
    }

    if (accounts.length === 0) {
      store.setShowAddAccount(true)
    }
  } finally {
    store.setLoading(false)
  }
}

export async function refreshMessages(): Promise<void> {
  const folderId = useMailStore.getState().selectedFolderId
  const [messages, total, folders] = await Promise.all([
    window.orbitMail.messages.list(folderId, MESSAGE_PAGE_SIZE, 0),
    window.orbitMail.messages.count(folderId),
    window.orbitMail.folders.list()
  ])

  applyMessagePage(messages, total, 0)
  useMailStore.getState().setFolders(folders)
}

export async function loadMoreMessages(): Promise<void> {
  const store = useMailStore.getState()
  if (store.messages.length >= store.messageTotal) return
  await loadFolderMessages(store.selectedFolderId, store.messageOffset)
}

export async function addAccount(provider: 'gmail' | 'o365'): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.add(provider)
    store.setShowAddAccount(false)
    store.setToast('Account added successfully')
    store.expandAccount(account.id)
    await loadInitialData()
    await window.orbitMail.sync.refresh()
    await refreshMessages()
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Failed to add account')
  }
}

export async function addManualAccount(input: ManualAccountInput): Promise<void> {
  const store = useMailStore.getState()
  try {
    const account = await window.orbitMail.accounts.addManual(input)
    store.setShowAddAccount(false)
    store.setToast('Account added successfully')
    store.expandAccount(account.id)
    await loadInitialData()
    await window.orbitMail.sync.refresh()
    await refreshMessages()
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
  store.setSelectedMessageId(messageId)
  store.setSelectedMessageIds([messageId])
  store.setSelectionAnchorId(messageId)
  scheduleSaveUiPreferences({ selectedMessageId: messageId })

  const summary =
    store.messages.find((m) => m.id === messageId) ??
    store.searchResults.find((m) => m.id === messageId)
  const wasUnread = summary ? !summary.isRead : false

  if (summary) {
    // Lightweight placeholder so the header renders synchronously; the body
    // arrives from messages.get a moment later.
    store.setSelectedMessage({
      ...summary,
      isRead: true,
      cc: '',
      bodyHtml: null,
      bodyText: null,
      attachments: []
    })
    store.setReaderLoading(true)
  } else {
    store.setSelectedMessage(null)
  }

  if (wasUnread) patchMessageInList(messageId, { isRead: true })

  const msg = await window.orbitMail.messages.get(messageId)
  const afterGet = useMailStore.getState()
  // Only apply the body if this is still the active selection.
  if (afterGet.selectedMessageId === messageId) {
    afterGet.setSelectedMessage(msg ? { ...msg, isRead: msg.isRead || wasUnread } : null)
    afterGet.setReaderLoading(false)
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
  store.setMessageOffset(0)
  store.setSearchQuery('')
  store.setSearchResults([])
  scheduleSaveUiPreferences({
    selectedFolderId: folderId,
    selectedMessageId: null
  })
  await loadFolderMessages(folderId, 0)
}

export async function moveMessageToTrash(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const msg = store.selectedMessage ?? (await window.orbitMail.messages.get(messageId))
  if (!msg) return

  const folders = store.folders.length
    ? store.folders
    : await window.orbitMail.folders.list()
  const currentFolder = folders.find((f) => f.id === msg.folderId)
  const alreadyInTrash = currentFolder?.type === 'trash'
  const trash = alreadyInTrash ? null : findAccountFolder(folders, msg.accountId, 'trash')

  // Optimistically remove from the list, clear selection, and show feedback
  // immediately — the server move + re-poll can take a few seconds, so we don't
  // wait for them to confirm the UI.
  removeMessagesFromList([messageId])
  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  store.setSelectedMessageIds([])
  store.setSelectionAnchorId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })
  store.setToast(
    trash ? `Moved to “${trash.name}”` : alreadyInTrash ? 'Deleted permanently' : 'Deleted'
  )

  try {
    if (trash) {
      await window.orbitMail.messages.move(messageId, trash.id)
    } else {
      await window.orbitMail.messages.delete(messageId)
    }
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

  const folders = store.folders.length
    ? store.folders
    : await window.orbitMail.folders.list()

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

  // Optimistically clear the list + selection before the server round-trips.
  removeMessagesFromList(ids)
  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  store.setSelectedMessageIds([])
  store.setSelectionAnchorId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })

  const label = destinations.length === 1 ? destinations[0] : 'Trash'
  try {
    const { deleted, failed } = await window.orbitMail.messages.deleteMany(items)
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

export async function archiveMessage(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  const msg = store.selectedMessage ?? (await window.orbitMail.messages.get(messageId))
  if (!msg) return

  const folders = store.folders.length
    ? store.folders
    : await window.orbitMail.folders.list()
  const archive = findArchiveFolder(folders, msg.accountId)

  if (!archive) {
    store.setToast('No archive folder found for this account')
    return
  }

  // Optimistically remove from the list + clear the reader, then move on the
  // server. The row is already gone locally; roll back on failure.
  removeMessagesFromList([messageId])
  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(null)
    store.setSelectedMessageId(null)
    store.setSelectedMessageIds([])
    scheduleSaveUiPreferences({ selectedMessageId: null })
  }
  store.setToast('Message archived')

  try {
    await window.orbitMail.messages.move(messageId, archive.id)
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

  const folders = store.folders.length
    ? store.folders
    : await window.orbitMail.folders.list()
  const junk = findAccountFolder(folders, msg.accountId, 'junk')

  if (!junk) {
    store.setToast('No junk folder found for this account')
    return
  }

  removeMessagesFromList([messageId])
  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(null)
    store.setSelectedMessageId(null)
    store.setSelectedMessageIds([])
    scheduleSaveUiPreferences({ selectedMessageId: null })
  }
  store.setToast('Message moved to Junk')

  try {
    await window.orbitMail.messages.move(messageId, junk.id)
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
  const folders = store.folders.length ? store.folders : await window.orbitMail.folders.list()
  const target = folders.find((folder) => folder.id === targetFolderId)

  removeMessagesFromList([messageId])
  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(null)
    store.setSelectedMessageId(null)
    store.setSelectedMessageIds([])
    scheduleSaveUiPreferences({ selectedMessageId: null })
  }
  store.setToast(`Message moved to ${target?.name ?? 'folder'}`)

  try {
    await window.orbitMail.messages.move(messageId, targetFolderId)
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
  const folders = store.folders.length ? store.folders : await window.orbitMail.folders.list()
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
}

export async function runSearch(query: string, accountId: string): Promise<void> {
  const store = useMailStore.getState()
  store.setSearchQuery(query)
  if (!query.trim()) {
    store.setSearchResults([])
    return
  }
  const results = await window.orbitMail.search.query(query, accountId)
  store.setSearchResults(results)
}

// Request an AI analysis of a message and cache it in the store. Surfaces
// errors via toast (and opens AI settings when no key is configured).
export async function analyzeMessage(messageId: string, force = false): Promise<void> {
  const store = useMailStore.getState()
  if (store.aiAnalyzingId) return
  store.setAiAnalyzingId(messageId)
  try {
    const result = await window.orbitMail.ai.analyze(messageId, force)
    if ('error' in result) {
      store.setToast(result.error)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    store.setAiAnalysis(messageId, result)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Analysis failed')
  } finally {
    store.setAiAnalyzingId(null)
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
