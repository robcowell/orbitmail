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
  SweepTask
} from '../../shared/types'
import {
  loadPersistedPreferences,
  scheduleSaveUiPreferences
} from './persistence'
import { findAccountFolder, findArchiveFolder } from '../utils/folders'
import { resolveSearchAccountId } from '../utils/search'

export const MESSAGE_PAGE_SIZE = 200

interface MailState {
  accounts: Account[]
  folders: Folder[]
  messages: MessageSummary[]
  messageOffset: number
  messageTotal: number
  selectedMessageId: string | null
  selectedMessage: MessageDetail | null
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
  sweepAnalyzedCount: number

  setAccounts: (accounts: Account[]) => void
  setFolders: (folders: Folder[]) => void
  setMessages: (messages: MessageSummary[]) => void
  appendMessages: (messages: MessageSummary[]) => void
  setMessageOffset: (offset: number) => void
  setMessageTotal: (total: number) => void
  setSelectedMessageId: (id: string | null) => void
  setSelectedMessage: (msg: MessageDetail | null) => void
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
  setSweepResult: (tasks: SweepTask[], analyzedCount: number) => void
}

export const useMailStore = create<MailState>((set) => ({
  accounts: [],
  folders: [],
  messages: [],
  messageOffset: 0,
  messageTotal: 0,
  selectedMessageId: null,
  selectedMessage: null,
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
  sweepAnalyzedCount: 0,

  setAccounts: (accounts) => set({ accounts }),
  setFolders: (folders) => set({ folders }),
  setMessages: (messages) => set({ messages }),
  appendMessages: (messages) =>
    set((state) => ({ messages: [...state.messages, ...messages] })),
  setMessageOffset: (offset) => set({ messageOffset: offset }),
  setMessageTotal: (total) => set({ messageTotal: total }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
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
  setSweepResult: (tasks, analyzedCount) =>
    set({ sweepTasks: tasks, sweepAnalyzedCount: analyzedCount }),
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

    const accounts = await window.orbitMail.accounts.list()
    const folders = await window.orbitMail.folders.list()
    const syncStatus = await window.orbitMail.sync.getStatus()

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
export async function selectMessage(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  store.setSelectedMessageId(messageId)
  store.setSelectedMessageIds([messageId])
  store.setSelectionAnchorId(messageId)
  scheduleSaveUiPreferences({ selectedMessageId: messageId })
  const msg = await window.orbitMail.messages.get(messageId)
  store.setSelectedMessage(msg)
  if (msg && !msg.isRead) {
    await window.orbitMail.messages.markRead(messageId, true)
    const current = useMailStore.getState()
    if (current.searchQuery.trim()) {
      const accountId = resolveSearchAccountId(current.selectedFolderId, current.folders)
      if (accountId) {
        await runSearch(current.searchQuery, accountId)
      }
    } else {
      await refreshMessages()
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
  await refreshMessages()
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

  // Optimistically clear the list + selection before the server round-trips.
  removeMessagesFromList(ids)
  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  store.setSelectedMessageIds([])
  store.setSelectionAnchorId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })

  let deleted = 0
  let failed = 0
  const destinations: string[] = []
  for (const id of ids) {
    try {
      const msg = await window.orbitMail.messages.get(id)
      if (!msg) continue
      const currentFolder = folders.find((f) => f.id === msg.folderId)
      const trash = currentFolder?.type === 'trash' ? null : findAccountFolder(folders, msg.accountId, 'trash')
      const dest = trash ? trash.name : 'Trash'
      if (trash) {
        await window.orbitMail.messages.move(id, trash.id)
      } else {
        await window.orbitMail.messages.delete(id)
      }
      if (!destinations.includes(dest)) destinations.push(dest)
      deleted += 1
    } catch {
      failed += 1
    }
  }

  const label = destinations.length === 1 ? destinations[0] : 'Trash'
  store.setToast(
    failed > 0
      ? `${deleted} moved to ${label}, ${failed} failed`
      : `${deleted} moved to ${label}`
  )
  await refreshMessages()
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

  await window.orbitMail.messages.move(messageId, archive.id)
  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })
  store.setToast('Message archived')
  await refreshMessages()
}

export async function markMessageUnread(messageId: string): Promise<void> {
  await window.orbitMail.messages.markRead(messageId, false)
  const msg = await window.orbitMail.messages.get(messageId)
  useMailStore.getState().setSelectedMessage(msg)
  await refreshMessages()
}

export async function markMessageRead(messageId: string): Promise<void> {
  await window.orbitMail.messages.markRead(messageId, true)
  const msg = await window.orbitMail.messages.get(messageId)
  const store = useMailStore.getState()
  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(msg)
  }
  await refreshMessages()
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

  await window.orbitMail.messages.move(messageId, junk.id)

  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(null)
    store.setSelectedMessageId(null)
    scheduleSaveUiPreferences({ selectedMessageId: null })
  }

  store.setToast('Message moved to Junk')
  await refreshMessages()
}

export async function moveMessageToFolder(
  messageId: string,
  targetFolderId: string
): Promise<void> {
  const store = useMailStore.getState()
  const folders = store.folders.length ? store.folders : await window.orbitMail.folders.list()
  const target = folders.find((folder) => folder.id === targetFolderId)

  await window.orbitMail.messages.move(messageId, targetFolderId)

  if (store.selectedMessageId === messageId) {
    store.setSelectedMessage(null)
    store.setSelectedMessageId(null)
    scheduleSaveUiPreferences({ selectedMessageId: null })
  }

  store.setToast(`Message moved to ${target?.name ?? 'folder'}`)
  await refreshMessages()
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
  await window.orbitMail.messages.setFlag(messageId, flagColor)
  const msg = await window.orbitMail.messages.get(messageId)
  const store = useMailStore.getState()
  if (store.selectedMessageId === messageId && msg) {
    store.setSelectedMessage(msg)
  }
  await refreshMessages()
}

export async function toggleMessageStar(messageId: string, isStarred: boolean): Promise<void> {
  await window.orbitMail.messages.toggleStar(messageId, isStarred)
  const msg = await window.orbitMail.messages.get(messageId)
  useMailStore.getState().setSelectedMessage(msg)
  await refreshMessages()
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

// Sweep the current folder's unread mail for outstanding tasks and open the
// Tasks digest. Errors surface via toast (and open AI settings if no key).
export async function runSweep(): Promise<void> {
  const store = useMailStore.getState()
  if (store.sweeping) return
  store.setShowTasks(true)
  store.setSweeping(true)
  store.setSweepResult([], 0)
  try {
    const result = await window.orbitMail.ai.sweep(store.selectedFolderId)
    if ('error' in result) {
      store.setToast(result.error)
      store.setShowTasks(false)
      const status = await window.orbitMail.ai.getStatus()
      if (!status.configured) store.setShowAiSettings(true)
      return
    }
    store.setSweepResult(result.tasks, result.analyzedCount)
  } catch (err) {
    store.setToast(err instanceof Error ? err.message : 'Sweep failed')
    store.setShowTasks(false)
  } finally {
    store.setSweeping(false)
  }
}
