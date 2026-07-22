import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  OrbitMailAPI,
  ComposePayload,
  SyncStatus,
  ManualAccountInput,
  UiPreferences,
  PersistedAppState,
  FlagColor,
  SweepScope,
  DraftTone
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
    list: (folderId, limit, offset, unreadOnly) =>
      ipcRenderer.invoke('messages:list', folderId, limit, offset, unreadOnly),
    count: (folderId, unreadOnly) => ipcRenderer.invoke('messages:count', folderId, unreadOnly),
    listThreads: (folderId, limit, offset, unreadOnly) =>
      ipcRenderer.invoke('messages:listThreads', folderId, limit, offset, unreadOnly),
    countThreads: (folderId, unreadOnly) =>
      ipcRenderer.invoke('messages:countThreads', folderId, unreadOnly),
    getThread: (accountId, threadId) =>
      ipcRenderer.invoke('messages:getThread', accountId, threadId),
    get: (messageId) => ipcRenderer.invoke('messages:get', messageId),
    markRead: (messageId, isRead) =>
      ipcRenderer.invoke('messages:markRead', messageId, isRead),
    toggleStar: (messageId, isStarred) =>
      ipcRenderer.invoke('messages:toggleStar', messageId, isStarred),
    setFlag: (messageId, flagColor) =>
      ipcRenderer.invoke('messages:setFlag', messageId, flagColor),
    delete: (messageId) => ipcRenderer.invoke('messages:delete', messageId),
    deleteMany: (items) => ipcRenderer.invoke('messages:deleteMany', items),
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
    query: (text, accountId, field, limit) =>
      ipcRenderer.invoke('search:query', text, accountId, field, limit),
    server: (text, accountId, field) =>
      ipcRenderer.invoke('search:server', text, accountId, field)
  },
  compose: {
    open: (payload) => ipcRenderer.invoke('compose:open', payload),
    send: (payload) => ipcRenderer.invoke('compose:send', payload),
    pickAttachments: () => ipcRenderer.invoke('compose:pickAttachments'),
    statAttachments: (paths: string[]) => ipcRenderer.invoke('compose:statAttachments', paths),
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
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
  print: {
    document: (html: string) => ipcRenderer.invoke('print:document', html)
  },
  app: {
    onNeedsAccount: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('app:needsAccount', handler)
      return () => ipcRenderer.removeListener('app:needsAccount', handler)
    },
    getSecureStorageStatus: () => ipcRenderer.invoke('app:getSecureStorageStatus')
  },
  attachments: {
    download: (attachmentId) => ipcRenderer.invoke('attachments:download', attachmentId),
    open: (attachmentId) => ipcRenderer.invoke('attachments:open', attachmentId),
    saveAs: (attachmentId) => ipcRenderer.invoke('attachments:saveAs', attachmentId),
    saveAll: (messageId) => ipcRenderer.invoke('attachments:saveAll', messageId)
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
  oauth: {
    getStatus: () => ipcRenderer.invoke('oauth:getStatus'),
    saveCredentials: (values) => ipcRenderer.invoke('oauth:saveCredentials', values)
  },
  ai: {
    analyze: (messageId: string, force?: boolean, includeAttachments?: boolean) =>
      ipcRenderer.invoke('ai:analyze', messageId, force, includeAttachments),
    draftReply: (messageId: string, tone: DraftTone, mode?: 'reply' | 'reply-all') =>
      ipcRenderer.invoke('ai:draftReply', messageId, tone, mode),
    sweep: (folderId: string, scope: SweepScope) =>
      ipcRenderer.invoke('ai:sweep', folderId, scope),
    getTasks: (folderId: string) => ipcRenderer.invoke('ai:getTasks', folderId),
    flagAsTask: (folderId: string, messageId: string) =>
      ipcRenderer.invoke('ai:flagAsTask', folderId, messageId),
    getCachedAnalysis: (messageId: string) =>
      ipcRenderer.invoke('ai:getCachedAnalysis', messageId),
    exportTasks: (markdown: string, defaultName: string) =>
      ipcRenderer.invoke('ai:exportTasks', markdown, defaultName),
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
