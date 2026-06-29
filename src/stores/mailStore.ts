import { create } from 'zustand'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  SyncStatus,
  ManualAccountInput,
  FlagColor
} from '../../shared/types'
import {
  loadPersistedPreferences,
  scheduleSaveUiPreferences
} from './persistence'
import { findAccountFolder, findArchiveFolder } from '../utils/folders'

export const MESSAGE_PAGE_SIZE = 200

interface MailState {
  accounts: Account[]
  folders: Folder[]
  messages: MessageSummary[]
  messageOffset: number
  messageTotal: number
  selectedMessageId: string | null
  selectedMessage: MessageDetail | null
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

  setAccounts: (accounts: Account[]) => void
  setFolders: (folders: Folder[]) => void
  setMessages: (messages: MessageSummary[]) => void
  appendMessages: (messages: MessageSummary[]) => void
  setMessageOffset: (offset: number) => void
  setMessageTotal: (total: number) => void
  setSelectedMessageId: (id: string | null) => void
  setSelectedMessage: (msg: MessageDetail | null) => void
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
}

export const useMailStore = create<MailState>((set) => ({
  accounts: [],
  folders: [],
  messages: [],
  messageOffset: 0,
  messageTotal: 0,
  selectedMessageId: null,
  selectedMessage: null,
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

  setAccounts: (accounts) => set({ accounts }),
  setFolders: (folders) => set({ folders }),
  setMessages: (messages) => set({ messages }),
  appendMessages: (messages) =>
    set((state) => ({ messages: [...state.messages, ...messages] })),
  setMessageOffset: (offset) => set({ messageOffset: offset }),
  setMessageTotal: (total) => set({ messageTotal: total }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setShowAddAccount: (show) => set({ showAddAccount: show }),
  setToast: (msg) => set({ toast: msg }),
  setLoading: (loading) => set({ loading }),
  setIsOnline: (online) => set({ isOnline: online }),
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

/** Debounced refresh for background sync (IDLE / polling). Avoids list flicker. */
export function scheduleRefreshMessages(delayMs?: number): void {
  const resolvedDelay =
    delayMs ??
    (useMailStore.getState().messages.length === 0 ? 0 : 400)
  if (refreshMessagesTimer) clearTimeout(refreshMessagesTimer)
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

export async function selectMessage(messageId: string): Promise<void> {
  const store = useMailStore.getState()
  store.setSelectedMessageId(messageId)
  scheduleSaveUiPreferences({ selectedMessageId: messageId })
  const msg = await window.orbitMail.messages.get(messageId)
  store.setSelectedMessage(msg)
  if (msg && !msg.isRead) {
    await window.orbitMail.messages.markRead(messageId, true)
    await refreshMessages()
  }
}

export async function selectFolder(folderId: string | 'unified'): Promise<void> {
  const store = useMailStore.getState()
  store.setSelectedFolderId(folderId)
  store.setSelectedMessageId(null)
  store.setSelectedMessage(null)
  store.setMessageOffset(0)
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

  if (currentFolder?.type === 'trash') {
    await window.orbitMail.messages.delete(messageId)
    store.setToast('Message deleted')
  } else {
    const trash = findAccountFolder(folders, msg.accountId, 'trash')
    if (!trash) {
      await window.orbitMail.messages.delete(messageId)
      store.setToast('Message deleted')
    } else {
      await window.orbitMail.messages.move(messageId, trash.id)
      store.setToast('Message moved to Trash')
    }
  }

  store.setSelectedMessage(null)
  store.setSelectedMessageId(null)
  scheduleSaveUiPreferences({ selectedMessageId: null })
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

export async function runSearch(query: string): Promise<void> {
  const store = useMailStore.getState()
  store.setSearchQuery(query)
  if (!query.trim()) {
    store.setSearchResults([])
    return
  }
  const results = await window.orbitMail.search.query(query)
  store.setSearchResults(results)
}
