import { create } from 'zustand'
import type {
  Account,
  Folder,
  MessageSummary,
  MessageDetail,
  SyncStatus,
  ManualAccountInput
} from '../../shared/types'
import {
  loadPersistedPreferences,
  scheduleSaveUiPreferences
} from './persistence'

interface MailState {
  accounts: Account[]
  folders: Folder[]
  messages: MessageSummary[]
  selectedMessageId: string | null
  selectedMessage: MessageDetail | null
  selectedFolderId: string | 'unified'
  searchQuery: string
  searchResults: MessageSummary[]
  syncStatus: SyncStatus
  showAddAccount: boolean
  toast: string | null
  loading: boolean
  collapsedAccountIds: Record<string, boolean>

  setAccounts: (accounts: Account[]) => void
  setFolders: (folders: Folder[]) => void
  setMessages: (messages: MessageSummary[]) => void
  setSelectedMessageId: (id: string | null) => void
  setSelectedMessage: (msg: MessageDetail | null) => void
  setSelectedFolderId: (id: string | 'unified') => void
  setSearchQuery: (q: string) => void
  setSearchResults: (results: MessageSummary[]) => void
  setSyncStatus: (status: SyncStatus) => void
  setShowAddAccount: (show: boolean) => void
  setToast: (msg: string | null) => void
  setLoading: (loading: boolean) => void
  toggleAccountCollapsed: (accountId: string) => void
  expandAccount: (accountId: string) => void
}

export const useMailStore = create<MailState>((set) => ({
  accounts: [],
  folders: [],
  messages: [],
  selectedMessageId: null,
  selectedMessage: null,
  selectedFolderId: 'unified',
  searchQuery: '',
  searchResults: [],
  syncStatus: { syncing: false, lastSyncAt: null, error: null, syncCurrent: 0, syncTotal: 0 },
  showAddAccount: false,
  toast: null,
  loading: false,
  collapsedAccountIds: {},

  setAccounts: (accounts) => set({ accounts }),
  setFolders: (folders) => set({ folders }),
  setMessages: (messages) => set({ messages }),
  setSelectedMessageId: (id) => set({ selectedMessageId: id }),
  setSelectedMessage: (msg) => set({ selectedMessage: msg }),
  setSelectedFolderId: (id) => set({ selectedFolderId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
  setSearchResults: (results) => set({ searchResults: results }),
  setSyncStatus: (status) => set({ syncStatus: status }),
  setShowAddAccount: (show) => set({ showAddAccount: show }),
  setToast: (msg) => set({ toast: msg }),
  setLoading: (loading) => set({ loading }),
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
    })
}))

export async function loadInitialData(): Promise<void> {
  const store = useMailStore.getState()
  store.setLoading(true)
  try {
    await loadPersistedPreferences()
    const persisted = useMailStore.getState()

    const accounts = await window.orbitMail.accounts.list()
    const folders = await window.orbitMail.folders.list()
    const messages = await window.orbitMail.messages.list(persisted.selectedFolderId)
    const syncStatus = await window.orbitMail.sync.getStatus()

    store.setAccounts(accounts)
    store.setFolders(folders)
    store.setMessages(messages)
    store.setSyncStatus(syncStatus)

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
  const store = useMailStore.getState()
  const messages = await window.orbitMail.messages.list(store.selectedFolderId)
  store.setMessages(messages)
  const folders = await window.orbitMail.folders.list()
  store.setFolders(folders)
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
  scheduleSaveUiPreferences({
    selectedFolderId: folderId,
    selectedMessageId: null
  })
  const messages = await window.orbitMail.messages.list(folderId)
  store.setMessages(messages)
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
