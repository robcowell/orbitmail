export type Provider = 'gmail' | 'o365' | 'imap' | 'pop3'

export type FolderType = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'custom'

export type ConnectionSecurity = 'ssl' | 'starttls' | 'none'

export interface ServerConfig {
  host: string
  port: number
  security: ConnectionSecurity
}

export interface ManualAccountInput {
  email: string
  displayName?: string
  username: string
  password: string
  incomingProtocol: 'imap' | 'pop3'
  incoming: ServerConfig
  outgoing: ServerConfig
}

export interface AutodetectResult {
  settings: Partial<ManualAccountInput> | null
  source: 'autoconfig' | 'guess' | null
  message: string
}

export interface Account {
  id: string
  provider: Provider
  email: string
  displayName: string
}

export interface Folder {
  id: string
  accountId: string
  imapPath: string
  name: string
  type: FolderType
  unreadCount: number
}

export interface MessageSummary {
  id: string
  folderId: string
  accountId: string
  uid: number
  messageId: string | null
  from: string
  to: string
  subject: string
  snippet: string
  date: number
  isRead: boolean
  isStarred: boolean
  hasAttachments: boolean
}

export interface Attachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  localPath: string | null
}

export interface MessageDetail extends MessageSummary {
  cc: string
  bodyHtml: string | null
  bodyText: string | null
  attachments: Attachment[]
}

export interface ComposePayload {
  accountId: string
  to: string
  cc?: string
  bcc?: string
  subject: string
  bodyHtml: string
  bodyText: string
  inReplyTo?: string
  references?: string
  attachmentPaths?: string[]
  mode?: 'new' | 'reply' | 'forward'
  originalMessageId?: string
}

export interface SyncStatus {
  syncing: boolean
  lastSyncAt: number | null
  error: string | null
  syncCurrent: number
  syncTotal: number
}

export interface UiPreferences {
  darkMode: boolean
  selectedFolderId: string | 'unified'
  selectedMessageId: string | null
  collapsedAccountIds: Record<string, boolean>
}

export interface PersistedAppState {
  ui: UiPreferences
  lastSyncAt: number | null
  window?: {
    width: number
    height: number
    x?: number
    y?: number
  }
}

export interface OrbitMailAPI {
  accounts: {
    list: () => Promise<Account[]>
    add: (provider: 'gmail' | 'o365') => Promise<Account>
    addManual: (input: ManualAccountInput) => Promise<Account>
    autodetect: (email: string) => Promise<AutodetectResult>
    remove: (accountId: string) => Promise<void>
  }
  folders: {
    list: (accountId?: string) => Promise<Folder[]>
  }
  messages: {
    list: (folderId: string | 'unified', limit?: number, offset?: number) => Promise<MessageSummary[]>
    get: (messageId: string) => Promise<MessageDetail | null>
    markRead: (messageId: string, isRead: boolean) => Promise<void>
    delete: (messageId: string) => Promise<void>
    move: (messageId: string, targetFolderId: string) => Promise<void>
  }
  sync: {
    refresh: (accountId?: string) => Promise<void>
    getStatus: () => Promise<SyncStatus>
    onStatusChange: (callback: (status: SyncStatus) => void) => () => void
    onMessagesUpdated: (callback: () => void) => () => void
  }
  search: {
    query: (text: string, limit?: number) => Promise<MessageSummary[]>
  }
  compose: {
    open: (payload?: Partial<ComposePayload>) => Promise<void>
    send: (payload: ComposePayload) => Promise<void>
    onOpen: (callback: (payload: Partial<ComposePayload>) => void) => () => void
  }
  attachments: {
    download: (attachmentId: string) => Promise<string>
    open: (attachmentId: string) => Promise<void>
  }
  preferences: {
    get: () => Promise<PersistedAppState>
    saveUi: (ui: Partial<UiPreferences>) => Promise<UiPreferences>
    save: (state: Partial<PersistedAppState>) => Promise<PersistedAppState>
  }
}

declare global {
  interface Window {
    orbitMail: OrbitMailAPI
  }
}
