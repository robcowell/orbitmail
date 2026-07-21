export type Provider = 'gmail' | 'o365' | 'imap' | 'pop3'

export type FolderType = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'custom'

// Which field(s) a search matches against. 'all' spans sender, recipient,
// subject and body.
export type SearchField = 'all' | 'from' | 'to' | 'subject' | 'body'

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
  syncDays: number
}

export interface AccountInfo {
  id: string
  provider: Provider
  providerLabel: string
  email: string
  displayName: string
  createdAt: number
  folderCount: number
  messageCount: number
  unreadCount: number
  syncDays: number
  localStorageBytes: number
  attachmentCount: number
  downloadedAttachmentCount: number
}

export interface Folder {
  id: string
  accountId: string
  imapPath: string
  name: string
  type: FolderType
  unreadCount: number
  isVirtualView: boolean
}

export type FlagColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'gray'

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
  flagColor: FlagColor | null
  hasAttachments: boolean
  // Conversation grouping key derived from RFC 5322 threading headers.
  threadId: string | null
}

export interface Attachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  localPath: string | null
}

// One collapsed conversation row in the message list. Represents a thread as it
// appears in the current folder/view (latest message + in-folder aggregates);
// opening it loads the full cross-folder conversation via getThread.
export interface ThreadSummary {
  threadId: string
  accountId: string
  // The most recent message in this folder — drives the row's subject/snippet/date.
  latestMessageId: string
  from: string
  subject: string
  snippet: string
  date: number
  isStarred: boolean
  flagColor: FlagColor | null
  hasAttachments: boolean
  messageCount: number
  hasUnread: boolean
  // Distinct sender display names, oldest first.
  participants: string[]
}

export interface MessageDetail extends MessageSummary {
  cc: string
  // Raw References header (space-separated Message-IDs) — used to build a proper
  // References chain when replying.
  references: string | null
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
  // Prior conversation content shown as a collapsible "quoted text" block in the
  // composer, kept separate from the new-message body while editing. On send the
  // composer combines the new body with this quote.
  quotedHtml?: string
  quotedText?: string
  inReplyTo?: string
  references?: string
  attachmentPaths?: string[]
  mode?: 'new' | 'reply' | 'reply-all' | 'forward' | 'forward-attachment' | 'redirect' | 'send-again'
  originalMessageId?: string
}

// A pending attachment in the composer: absolute path plus display metadata.
export interface AttachmentDraft {
  path: string
  name: string
  size: number
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
  favoriteFolderIds: string[]
  // Group the message list into conversations. When false, every message is
  // shown as its own flat row.
  threadedView: boolean
  // Per-account "unread only" list filter. Keyed by account id, plus 'unified'
  // for the combined inbox view. Missing/false = show all messages.
  unreadFilterByAccount: Record<string, boolean>
  // Last-used search scope (All / From / To / Subject / Body).
  searchField: SearchField
}

export interface PersistedAppState {
  ui: UiPreferences
  lastSyncAt: number | null
  handleMailtoLinks?: boolean
  mutedSenders: string[]
  blockedSenders: string[]
  window?: {
    width: number
    height: number
    x?: number
    y?: number
  }
}

export interface AiAnalysis {
  summary: string
  actionItems: string[]
  questions: string[]
  keyContext: string[]
  generatedAt: number
  cached: boolean
  // Attachments that were requested but couldn't be sent to the model
  // (unsupported type, too large, or un-fetchable). Transient — not persisted.
  skippedAttachments?: string[]
}

export interface AiStatus {
  configured: boolean
}

export type AiPriority = 'urgent' | 'high' | 'medium' | 'low'

// Which messages a sweep should consider. Defaults to unread everywhere.
export type SweepScope = 'unread' | 'all'

export interface SweepTask {
  // Stable dedupe key (source message + normalized task text). Used to mark a
  // task done and to keep completed tasks from resurfacing on later sweeps.
  id: string
  task: string
  priority: AiPriority
  sourceMessageId: string
  sourceSubject: string
  sourceFrom: string
}

export interface CompletedTask extends SweepTask {
  completedAt: number
}

export interface SweepResult {
  tasks: SweepTask[]
  completed: CompletedTask[]
  analyzedCount: number
  // How many messages were freshly sent to the model this sweep (the rest were
  // served from the per-message cache). 0 means the sweep spent no API tokens.
  freshCount: number
  scope: SweepScope
  sweptAt: number | null
}

export type AiAnalysisResult = AiAnalysis | { error: string }

export type AiSweepResult = SweepResult | { error: string }

// How verbose an AI-drafted reply should be.
export type DraftTone = 'brief' | 'neutral' | 'detailed'

// A generated reply draft: plain body text ready to seed the composer.
export interface ReplyDraft {
  bodyText: string
}

export type AiDraftResult = ReplyDraft | { error: string }

export interface OrbitMailAPI {
  folders: {
    list: (accountId?: string) => Promise<Folder[]>
    create: (accountId: string, name: string) => Promise<void>
    export: (folderId: string) => Promise<number>
    emptyTrash: (accountId: string) => Promise<number>
    emptyJunk: (accountId: string) => Promise<number>
    markAllRead: (folderId: string) => Promise<number>
  }
  accounts: {
    list: () => Promise<Account[]>
    add: (provider: 'gmail' | 'o365') => Promise<Account>
    addManual: (input: ManualAccountInput) => Promise<Account>
    autodetect: (email: string) => Promise<AutodetectResult>
    remove: (accountId: string) => Promise<void>
    getInfo: (accountId: string) => Promise<AccountInfo>
    updateDisplayName: (accountId: string, displayName: string) => Promise<Account>
    updateSyncDays: (accountId: string, syncDays: number) => Promise<Account>
  }
  messages: {
    list: (
      folderId: string | 'unified',
      limit?: number,
      offset?: number,
      unreadOnly?: boolean
    ) => Promise<MessageSummary[]>
    count: (folderId: string | 'unified', unreadOnly?: boolean) => Promise<number>
    listThreads: (
      folderId: string | 'unified',
      limit?: number,
      offset?: number,
      unreadOnly?: boolean
    ) => Promise<ThreadSummary[]>
    countThreads: (folderId: string | 'unified', unreadOnly?: boolean) => Promise<number>
    getThread: (accountId: string, threadId: string) => Promise<MessageDetail[]>
    get: (messageId: string) => Promise<MessageDetail | null>
    markRead: (messageId: string, isRead: boolean) => Promise<void>
    toggleStar: (messageId: string, isStarred: boolean) => Promise<void>
    setFlag: (messageId: string, flagColor: FlagColor | null) => Promise<void>
    delete: (messageId: string) => Promise<void>
    deleteMany: (
      items: { id: string; targetFolderId: string | null }[]
    ) => Promise<{ deleted: number; failed: number }>
    move: (messageId: string, targetFolderId: string) => Promise<void>
    copy: (messageId: string, targetFolderId: string) => Promise<void>
  }
  sync: {
    refresh: (accountId?: string) => Promise<void>
    getStatus: () => Promise<SyncStatus>
    onStatusChange: (callback: (status: SyncStatus) => void) => () => void
    onMessagesUpdated: (callback: () => void) => () => void
  }
  search: {
    query: (
      text: string,
      accountId: string,
      field?: SearchField,
      limit?: number
    ) => Promise<MessageSummary[]>
    // Live IMAP search on the server, used as a fallback when the local cache
    // has no match. Returns [] for POP3 accounts.
    server: (text: string, accountId: string, field?: SearchField) => Promise<MessageSummary[]>
  }
  compose: {
    open: (payload?: Partial<ComposePayload>) => Promise<void>
    send: (payload: ComposePayload) => Promise<void>
    pickAttachments: () => Promise<AttachmentDraft[]>
    statAttachments: (paths: string[]) => Promise<AttachmentDraft[]>
    getPathForFile: (file: File) => string
    close: () => Promise<void>
    onOpen: (callback: (payload: Partial<ComposePayload>) => void) => () => void
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  print: {
    // Renders a self-contained HTML document in an offscreen window and opens
    // the OS print dialog. Resolves { printed: false } if the user cancels.
    document: (html: string) => Promise<{ printed: boolean }>
  }
  app: {
    onNeedsAccount: (callback: () => void) => () => void
  }
  attachments: {
    download: (attachmentId: string) => Promise<string>
    /** Resolves false if the user declined the executable-attachment warning. */
    open: (attachmentId: string) => Promise<boolean>
    // Prompt for a destination and save one attachment. Resolves the saved path,
    // or null if the user cancelled.
    saveAs: (attachmentId: string) => Promise<string | null>
    // Prompt for a folder and save all of a message's attachments into it.
    // Resolves the number of files saved, or null if the user cancelled.
    saveAll: (messageId: string) => Promise<number | null>
  }
  preferences: {
    get: () => Promise<PersistedAppState>
    saveUi: (ui: Partial<UiPreferences>) => Promise<UiPreferences>
    save: (state: Partial<PersistedAppState>) => Promise<PersistedAppState>
    setHandleMailtoLinks: (enabled: boolean) => Promise<boolean>
    muteSender: (email: string) => Promise<void>
    blockSender: (email: string) => Promise<void>
  }
  ai: {
    analyze: (
      messageId: string,
      force?: boolean,
      includeAttachments?: boolean
    ) => Promise<AiAnalysisResult>
    draftReply: (
      messageId: string,
      tone: DraftTone,
      mode?: 'reply' | 'reply-all'
    ) => Promise<AiDraftResult>
    sweep: (folderId: string | 'unified', scope: SweepScope) => Promise<AiSweepResult>
    getTasks: (folderId: string | 'unified') => Promise<SweepResult>
    // Force one email into the current task list, using the model to identify
    // the action. Persists as a manual task that sweeps won't remove.
    flagAsTask: (folderId: string | 'unified', messageId: string) => Promise<AiSweepResult>
    // Cached-only AI analysis (never calls the API); null when none is stored.
    getCachedAnalysis: (messageId: string) => Promise<AiAnalysis | null>
    exportTasks: (markdown: string, defaultName: string) => Promise<string | null>
    completeTask: (folderId: string | 'unified', taskId: string) => Promise<void>
    reopenTask: (folderId: string | 'unified', taskId: string) => Promise<void>
    getStatus: () => Promise<AiStatus>
    setApiKey: (key: string) => Promise<void>
    clearApiKey: () => Promise<void>
  }
}

declare global {
  interface Window {
    orbitMail: OrbitMailAPI
  }
}
