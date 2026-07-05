import { contextBridge, ipcRenderer } from 'electron'
import type {
  OrbitMailAPI,
  ComposePayload,
  SyncStatus,
  ManualAccountInput,
  UiPreferences,
  PersistedAppState,
  FlagColor,
  SweepScope
} from '../shared/types'

const api: OrbitMailAPI = {
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    add: (provider) => ipcRenderer.invoke('accounts:add', provider),
    addManual: (input: ManualAccountInput) =>
      ipcRenderer.invoke('accounts:addManual', input),
    autodetect: (email) => ipcRenderer.invoke('accounts:autodetect', email),
    remove: (accountId) => ipcRenderer.invoke('accounts:remove', accountId),
    getInfo: (accountId) => ipcRenderer.invoke('accounts:getInfo', accountId),
    updateDisplayName: (accountId, displayName) =>
      ipcRenderer.invoke('accounts:updateDisplayName', accountId, displayName),
    updateSyncDays: (accountId, syncDays) =>
      ipcRenderer.invoke('accounts:updateSyncDays', accountId, syncDays)
  },
  folders: {
    list: (accountId) => ipcRenderer.invoke('folders:list', accountId),
    create: (accountId, name) => ipcRenderer.invoke('folders:create', accountId, name),
    export: (folderId) => ipcRenderer.invoke('folders:export', folderId),
    emptyTrash: (accountId) => ipcRenderer.invoke('folders:emptyTrash', accountId),
    emptyJunk: (accountId) => ipcRenderer.invoke('folders:emptyJunk', accountId),
    markAllRead: (folderId) => ipcRenderer.invoke('folders:markAllRead', folderId)
  },
  messages: {
    list: (folderId, limit, offset) =>
      ipcRenderer.invoke('messages:list', folderId, limit, offset),
    count: (folderId) => ipcRenderer.invoke('messages:count', folderId),
    get: (messageId) => ipcRenderer.invoke('messages:get', messageId),
    markRead: (messageId, isRead) =>
      ipcRenderer.invoke('messages:markRead', messageId, isRead),
    toggleStar: (messageId, isStarred) =>
      ipcRenderer.invoke('messages:toggleStar', messageId, isStarred),
    setFlag: (messageId, flagColor) =>
      ipcRenderer.invoke('messages:setFlag', messageId, flagColor),
    delete: (messageId) => ipcRenderer.invoke('messages:delete', messageId),
    move: (messageId, targetFolderId) =>
      ipcRenderer.invoke('messages:move', messageId, targetFolderId),
    copy: (messageId, targetFolderId) =>
      ipcRenderer.invoke('messages:copy', messageId, targetFolderId)
  },
  sync: {
    refresh: (accountId) => ipcRenderer.invoke('sync:refresh', accountId),
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    onStatusChange: (callback) => {
      const handler = (_: unknown, status: SyncStatus) => callback(status)
      ipcRenderer.on('sync:status', handler)
      return () => ipcRenderer.removeListener('sync:status', handler)
    },
    onMessagesUpdated: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('sync:messagesUpdated', handler)
      return () => ipcRenderer.removeListener('sync:messagesUpdated', handler)
    }
  },
  search: {
    query: (text, accountId, limit) => ipcRenderer.invoke('search:query', text, accountId, limit)
  },
  compose: {
    open: (payload) => ipcRenderer.invoke('compose:open', payload),
    send: (payload) => ipcRenderer.invoke('compose:send', payload),
    pickAttachments: () => ipcRenderer.invoke('compose:pickAttachments'),
    close: () => ipcRenderer.invoke('compose:close'),
    onOpen: (callback) => {
      const handler = (_: unknown, payload: Partial<ComposePayload>) => callback(payload)
      ipcRenderer.on('compose:open', handler)
      return () => ipcRenderer.removeListener('compose:open', handler)
    }
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url)
  },
  app: {
    onNeedsAccount: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('app:needsAccount', handler)
      return () => ipcRenderer.removeListener('app:needsAccount', handler)
    }
  },
  attachments: {
    download: (attachmentId) => ipcRenderer.invoke('attachments:download', attachmentId),
    open: (attachmentId) => ipcRenderer.invoke('attachments:open', attachmentId)
  },
  preferences: {
    get: () => ipcRenderer.invoke('preferences:get'),
    saveUi: (ui: Partial<UiPreferences>) => ipcRenderer.invoke('preferences:saveUi', ui),
    save: (state: Partial<PersistedAppState>) => ipcRenderer.invoke('preferences:save', state),
    setHandleMailtoLinks: (enabled: boolean) =>
      ipcRenderer.invoke('preferences:setHandleMailtoLinks', enabled),
    muteSender: (email: string) => ipcRenderer.invoke('preferences:muteSender', email),
    blockSender: (email: string) => ipcRenderer.invoke('preferences:blockSender', email)
  },
  ai: {
    analyze: (messageId: string, force?: boolean) =>
      ipcRenderer.invoke('ai:analyze', messageId, force),
    sweep: (folderId: string, scope: SweepScope) =>
      ipcRenderer.invoke('ai:sweep', folderId, scope),
    getTasks: (folderId: string) => ipcRenderer.invoke('ai:getTasks', folderId),
    completeTask: (folderId: string, taskId: string) =>
      ipcRenderer.invoke('ai:completeTask', folderId, taskId),
    reopenTask: (folderId: string, taskId: string) =>
      ipcRenderer.invoke('ai:reopenTask', folderId, taskId),
    getStatus: () => ipcRenderer.invoke('ai:getStatus'),
    setApiKey: (key: string) => ipcRenderer.invoke('ai:setApiKey', key),
    clearApiKey: () => ipcRenderer.invoke('ai:clearApiKey')
  }
}

contextBridge.exposeInMainWorld('orbitMail', api)
