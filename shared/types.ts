import type { AiDetail, AiEffort } from './ai-models'

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
  /** Sanitized HTML appended to new messages. Empty when there is none. */
  signature: string
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

/**
 * A label carried by one or more of the messages asked about.
 *
 * `messageCount` is how many of them carry it, which is the difference between
 * a conversation that is labelled and one where a single reply is: Gmail lets
 * both exist, so the picker shows the second as partial rather than claiming
 * the conversation is labelled when it is not.
 */
export interface MessageLabel {
  folderId: string
  name: string
  imapPath: string
  /** Gmail's Inbox is a label like any other, and removing it is archiving. */
  isInbox: boolean
  messageCount: number
}

export interface LabelChangeResult {
  /** Messages the label was actually put on or taken off. */
  changed: number
  failed: number
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
  /**
   * Set when this row is a locally-saved draft rather than a synced message.
   * Drafts appear in the Drafts folder alongside any the server holds; clicking
   * one reopens the composer instead of the reader, and deleting one removes
   * the draft rather than moving mail to Trash.
   */
  draftId?: string
}

export interface Attachment {
  id: string
  messageId: string
  filename: string
  mimeType: string
  size: number
  localPath: string | null
  /**
   * An image the sender embedded in the message body — a signature logo — which
   * the reader shows underneath the text rather than as an attachment chip. The
   * row still exists and can still be opened or saved; it is only collapsed out
   * of the way, because a long reply chain accumulates one copy per reply.
   */
  inline: boolean
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
  // Distinct display names for the row's label, oldest first: senders, or — in a
  // Sent folder, where the sender is always the account owner — the recipients
  // of the copies that live in that folder.
  participants: string[]
  /** Set when this row is a locally-saved draft. See MessageSummary.draftId. */
  draftId?: string
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
  /**
   * A message for the user shown once when the composer opens — used when main
   * had to open it with something missing, e.g. a forward whose attachment
   * could not be downloaded. Not part of the message being sent.
   */
  notice?: string
  /**
   * The locally-saved draft this composer is editing, if any. Round-trips so
   * autosave updates one row rather than creating a new draft per keystroke
   * burst, and so sending can delete the right one.
   */
  draftId?: string
}

/**
 * A saved draft as the Drafts folder lists it. Drafts are local only — they are
 * never uploaded to the account's IMAP Drafts folder — so they live in their own
 * table rather than in `messages`, where the expunge reconciliation would delete
 * them for having no server uid.
 */
export interface DraftSummary {
  id: string
  accountId: string
  to: string
  subject: string
  snippet: string
  updatedAt: number
  hasAttachments: boolean
}

// A pending attachment in the composer: absolute path plus display metadata.
export interface AttachmentDraft {
  path: string
  name: string
  size: number
}

/**
 * How one mailbox is doing. Sync status used to be a single global object, so
 * with more than one account the UI could not say *which* one was syncing,
 * which had failed, or when each last succeeded — and one account's error hid
 * every other account's "last synced". This is the per-account truth; the
 * aggregate fields on `SyncStatus` are derived from it.
 */
export interface AccountSyncStatus {
  accountId: string
  /** Carried so the UI can name the account without joining the account list. */
  email: string
  syncing: boolean
  lastSyncAt: number | null
  /** This account's own failure, unjoined with anyone else's. */
  error: string | null
  /**
   * Whether signing in again is the fix — what raises the **Re-authenticate**
   * button.
   *
   * Set where the failure is classified, in the main process, because that is
   * the only place that knows. The renderer used to infer it by running
   * `/auth|token|login|expired|invalid_grant|consent/i` over `error`, which made
   * the button a property of the *prose*: rewording a sentence could silently
   * remove the user's only way out of a failing account, and a DNS failure whose
   * message happened to contain "token" would offer a pointless re-auth. Nothing
   * in the type system connected the two, and nothing failed when they diverged.
   *
   * Cleared when a new attempt starts, so a fixed password takes the button away
   * rather than leaving it until the next failure.
   */
  needsReauth: boolean
  /**
   * Whether the last attempt reached the server at all. An account that was
   * refused — an expired token, a wrong password — counts as **reached**: the
   * server answered, it just said no, and that is not an outage.
   *
   * `null` until an attempt has been made. This is the evidence the offline
   * banner is built from, because `navigator.onLine` reports only that a
   * network interface exists — a captive portal, a dropped VPN or a DNS failure
   * all read as online there.
   */
  reachedServer: boolean | null
}

/**
 * One message to put back where it was.
 *
 * Identified by its **RFC Message-ID**, not its local row id, because a move
 * does not preserve the row: the message is deleted locally, moved on the
 * server, and re-imported by the next poll under a new uid and a new id. A
 * message whose headers carry no Message-ID therefore cannot be undone, and is
 * counted as skipped rather than silently dropped.
 */
/** A message asleep in the Snoozed folder, and when it is due back. */
export interface SnoozedMessage {
  /** The scheduled action's id — what `unsnooze` takes. */
  id: string
  accountId: string
  wakeAt: number
  rfcMessageId: string
}

export interface UndoRelocateEntry {
  accountId: string
  rfcMessageId: string
  /** The folder it came from, and the folder undo puts it back in. */
  folderId: string
}

export interface UndoRelocateResult {
  restored: number
  /** Could not be found, or the move back failed. */
  failed: number
}

/** A send that has been accepted but not yet performed. */
export interface ScheduledSend {
  scheduledId: string
  /** When the message will actually go. Epoch ms. */
  dueAt: number
  /** The draft held for the length of the window, so Undo can reopen it. */
  draftId: string | null
}

export interface CancelSendResult {
  /** False when the hold had already expired — the message is gone. */
  cancelled: boolean
  draftId: string | null
}

export interface SyncStatus {
  /** True while *any* account is syncing. */
  syncing: boolean
  /**
   * The most recent successful sync across all accounts, for the aggregate
   * status line. Per-account timestamps live in `accounts` — read those before
   * telling the user a specific mailbox is up to date.
   */
  lastSyncAt: number | null
  /** Progress is pooled across accounts: one bar for the whole refresh. */
  syncCurrent: number
  syncTotal: number
  /** Keyed by account id. The source of truth for everything above. */
  accounts: Record<string, AccountSyncStatus>
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

/**
 * A manual (IMAP/POP3) account's server settings **without the password**.
 *
 * The stored credentials include the plaintext password, and this is what the
 * renderer is allowed to see instead. The renderer is the process whose whole
 * job is displaying untrusted email HTML, so a password that reaches it lands in
 * component state and is readable by anything that gets script execution there.
 * `hasPassword` is all it needs to know.
 */
export interface ManualAccountSettings {
  email: string
  displayName: string
  username: string
  incomingProtocol: 'imap' | 'pop3'
  incoming: ServerConfig
  outgoing: ServerConfig
  hasPassword: boolean
}

/**
 * An edit to those settings. `email` and `incomingProtocol` are absent by
 * design: `saveManualAccount` matches on email and would create a *second*
 * account row rather than editing this one, and `assertProviderUnchanged`
 * refuses an IMAP↔POP3 switch outright. Changing either means removing the
 * account and adding it again.
 */
export interface ManualAccountSettingsUpdate {
  displayName: string
  username: string
  incoming: ServerConfig
  outgoing: ServerConfig
  /** Omitted or empty = keep the stored password. It never round-trips. */
  password?: string
}

export interface WindowPreferences {
  width: number
  height: number
  x?: number
  y?: number
}

/**
 * The compose window's remembered size. **Size only, deliberately no position:**
 * every composer is a new window the window manager is entitled to place, and
 * pinning one to coordinates fights tiling desktops and strands the window
 * off-screen when a monitor goes away.
 *
 * `maximized` is what the setting is actually for — someone who writes maximized
 * wants the next message maximized, and remembering only the pixel size would
 * reopen a screen-filling window that is not maximized, which is worse than
 * either. Stored alongside the *unmaximized* size so restoring down still gives
 * a sensible window.
 */
export interface ComposeWindowPreferences {
  width: number
  height: number
  maximized?: boolean
}

// The persisted app state. This is the single declaration — the main process
// imports it from here rather than keeping its own copy, which is how the two
// used to drift (the sender arrays were required in one and optional in the
// other).
//
// Every field added here needs a default in DEFAULT_APP_STATE *and* a line in
// both readRawState and patchAppState (electron/services/preferences-service.ts).
// patchAppState is the one that bites: a patch that does not mention a key drops
// it on the next merge.
export interface PersistedAppState {
  ui: UiPreferences
  /**
   * Legacy single timestamp, kept so an install predating per-account status
   * still shows a last-synced time on first run: it seeds every account that
   * has no entry in `accountLastSyncAt` yet.
   */
  lastSyncAt: number | null
  /** Last successful sync per account id. Absent means never synced. */
  accountLastSyncAt?: Record<string, number>
  /** Register as the system handler for mailto: links. */
  handleMailtoLinks?: boolean
  /**
   * Closing the main window hides it to the tray instead of quitting. Only has
   * an effect where a tray actually exists — see `app:getPlatformCapabilities`.
   * Absent means true: an install predating this key keeps today's behaviour.
   */
  closeToTray?: boolean
  /** Desktop notification on new mail. Absent means true. */
  desktopNotifications?: boolean
  /**
   * Analyze includes readable attachments without asking. Absent means false:
   * attachments cost extra tokens, so the prompt-first behaviour is the one you
   * get by omission.
   */
  alwaysIncludeAttachments?: boolean
  /**
   * Page zoom, as an Electron zoom level (factor = 1.2 ^ level, so 0 is 100%).
   * Applies to every window. Absent means 0 — an install predating this key
   * opens at the size it always did.
   */
  zoomLevel?: number
  /**
   * Load remote images in every message, skipping the per-sender prompt. Absent
   * means false — the privacy-preserving default is the one you get by omission.
   */
  alwaysLoadRemoteImages?: boolean
  mutedSenders: string[]
  blockedSenders: string[]
  /** Senders whose remote images are loaded without the block prompt. */
  imageAllowedSenders: string[]
  /**
   * Which Claude model the AI features call, and how hard it may think. Absent
   * means the defaults in `shared/ai-models.ts`; anything unrecognised is
   * resolved back to them rather than sent to the API.
   */
  aiModel?: string
  aiEffort?: AiEffort
  /** How much the summaries say. Absent means the fuller default. */
  aiDetail?: AiDetail
  window?: WindowPreferences
  /** The compose window's size. Absent means the 640x720 it has always opened at. */
  composeWindow?: ComposeWindowPreferences
}

/**
 * What this desktop can actually do. The settings UI reads it so a toggle never
 * lies: there is no tray on most non-Linux desktops (and none on a Linux one
 * without a StatusNotifier host), and `setAsDefaultProtocolClient` silently
 * no-ops without an installed .desktop file — which is every `npm run dev` run.
 */
/** What the renderer reports when it has fallen over. See `app.reportRendererError`. */
export interface RendererErrorReport {
  source: 'render' | 'window'
  message: string
  stack?: string
  /** React's component stack, when an error boundary supplied one. */
  componentStack?: string
  /** Which window it came from, so a composer failure is distinguishable. */
  window?: string
}

export interface PlatformCapabilities {
  trayActive: boolean
  notificationsSupported: boolean
  mailtoHandlerActive: boolean
}

export interface AiAnalysis {
  summary: string
  /**
   * Every outstanding action the message implies, each with its owner — not
   * only the user's. Dropping other people's left the user unable to tell "you
   * owe nothing here" from "the model found nothing", and a message often
   * turns on what someone *else* has undertaken to do.
   */
  actionItems: ActionItem[]
  questions: string[]
  keyContext: string[]
  generatedAt: number
  cached: boolean
  /**
   * Whether this analysis was run *with* attachments. Absent on analyses
   * cached before the flag existed — which is why the reader says nothing
   * rather than guessing: unknown is a real state, and claiming either way
   * would be the same illusion the caveat exists to break.
   */
  attachmentsIncluded?: boolean
  // Attachments that were requested but couldn't be sent to the model
  // (unsupported type, too large, or un-fetchable). Cached alongside the
  // analysis and shown in the reader, so an answer that had to ignore an
  // attachment still says so when the message is reopened.
  skippedAttachments?: string[]
}

/** One outstanding commitment, and who owes it. */
export interface ActionItem {
  action: string
  /**
   * "You" for the user, otherwise the participant as the conversation names
   * them, or "Unassigned". Free text rather than an enum — the owners of a real
   * conversation are people, not a closed set — and derived from sender-written
   * content, so render it, never act on it.
   */
  owner: string
}

/**
 * A conversation summarized as a whole, rather than message by message.
 *
 * Separate from `AiAnalysis` because a thread carries its own extras
 * (decisions, staleness, how much of it was read), not because the action
 * items differ — both now use `ActionItem`, so "who owes this" reads the same
 * whether you are looking at one message or the whole conversation.
 */
export interface AiThreadAnalysis {
  summary: string
  decisions: string[]
  actionItems: ActionItem[]
  openQuestions: string[]
  generatedAt: number
  cached: boolean
  /** Distinct messages in the conversation when this was generated. */
  messageCount: number
  /** How many of those actually went to the model — the rest exceeded the cap. */
  analyzedCount: number
  /** Distinct messages in the conversation right now. */
  currentMessageCount: number
  /**
   * The conversation has changed since this was written. A stale summary is
   * still returned — it remains true about the earlier part of the thread — so
   * the UI must label it rather than present it as current.
   */
  stale: boolean
}

export type AiThreadAnalysisResult = AiThreadAnalysis | { error: string }

export interface AiStatus {
  configured: boolean
}

export type AiPriority = 'urgent' | 'high' | 'medium' | 'low'

// Which messages a sweep should consider. Defaults to unread everywhere.
// One compose-autocomplete suggestion. Collected from mail the account has sent
// and received (see electron/services/contacts.ts) — there is no address book.
// The counts are what ranked it and are shown to the user as "written to N
// times", so the suggestion can be judged rather than just trusted.
export interface ContactSuggestion {
  address: string
  name: string | null
  sentCount: number
  seenCount: number
}

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

export type OAuthCredentialKey =
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MICROSOFT_CLIENT_ID'
  | 'MICROSOFT_TENANT_ID'

export interface OAuthConfigStatus {
  /** Whether the provider has everything it needs to start a sign-in. */
  google: boolean
  microsoft: boolean
  /** Keys supplied by the environment — editing those in the app has no effect. */
  fromEnvironment: OAuthCredentialKey[]
  /** False when safeStorage is unavailable, so values are only base64-encoded. */
  encryptionAvailable: boolean
}

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
    /**
     * Store the account's signature. The renderer sanitizes before sending —
     * the main process has no DOM to do it with.
     */
    updateSignature: (accountId: string, signature: string) => Promise<void>
    /**
     * The account's stored signature, empty string when it has none.
     *
     * Exists for the composer's From switch, which needs one account's signature
     * and nothing else. `getInfo` also carries it, but computes message counts,
     * attachment stats and on-disk size to do so — too much work for a select
     * change, and none of it wanted.
     */
    getSignature: (accountId: string) => Promise<string>
    /**
     * A manual account's server settings. Never includes the password — see
     * ManualAccountSettings. Null for OAuth accounts, which have none.
     */
    getManualSettings: (accountId: string) => Promise<ManualAccountSettings | null>
    /** Verifies the settings before persisting them; throws if they fail. */
    updateManualSettings: (
      accountId: string,
      update: ManualAccountSettingsUpdate
    ) => Promise<Account>
    /**
     * Try the settings without saving. Resolves `{ ok: false, error }` rather
     * than rejecting, so the form can show the failure inline.
     */
    testManualSettings: (
      accountId: string,
      update: ManualAccountSettingsUpdate
    ) => Promise<{ ok: boolean; error?: string }>
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
    // Same batch relocation as deleteMany — each message goes to its target
    // folder — under a name that reads honestly at an archive/move call site.
    moveMany: (
      items: { id: string; targetFolderId: string | null }[]
    ) => Promise<{ deleted: number; failed: number }>
    move: (messageId: string, targetFolderId: string) => Promise<void>
    /**
     * Put a batch of relocated messages back where they came from — the reverse
     * of deleteMany/moveMany, and what the Undo action on the toast calls.
     * Entries are keyed by RFC Message-ID because the local row does not survive
     * a move; see UndoRelocateEntry.
     */
    undoRelocate: (entries: UndoRelocateEntry[]) => Promise<UndoRelocateResult>
    /**
     * Move messages to a real **Snoozed** folder and bring them back at
     * `wakeAt`. A real folder, not a local flag, so the message genuinely
     * leaves the inbox on your phone and in webmail too.
     *
     * A message whose headers carry no Message-ID cannot be found again when it
     * is due, so it cannot be snoozed — those come back in `failed`.
     */
    snooze: (
      messageIds: string[],
      wakeAt: number
    ) => Promise<{ snoozed: number; failed: number }>
    listSnoozed: () => Promise<SnoozedMessage[]>
    /** Bring one back now instead of waiting. False if it already came back. */
    unsnooze: (scheduledId: string) => Promise<boolean>
    /** Fires when a snoozed message has been returned to its folder. */
    onUnsnoozed: (callback: (rfcMessageId: string) => void) => () => void
    copy: (messageId: string, targetFolderId: string) => Promise<void>
    // Gmail only. The labels these messages carry, the labels the account has
    // to offer, and putting one on or taking one off the lot of them. Passing
    // every message in a conversation is the normal call: Gmail labels a
    // conversation, and so does this.
    labels: (messageIds: string[]) => Promise<MessageLabel[]>
    availableLabels: (accountId: string) => Promise<Folder[]>
    addLabel: (messageIds: string[], folderId: string) => Promise<LabelChangeResult>
    removeLabel: (messageIds: string[], folderId: string) => Promise<LabelChangeResult>
  }
  sync: {
    refresh: (accountId?: string) => Promise<void>
    getStatus: () => Promise<SyncStatus>
    onStatusChange: (callback: (status: SyncStatus) => void) => () => void
    onMessagesUpdated: (callback: () => void) => () => void
  }
  search: {
    /** `accountId` of null searches every account — the unified inbox scope. */
    query: (
      text: string,
      accountId: string | null,
      field?: SearchField,
      limit?: number
    ) => Promise<MessageSummary[]>
    // Live IMAP search on the server, used as a fallback when the local cache
    // has no match. Returns [] for POP3 accounts. A null accountId asks every
    // account concurrently and merges the results newest-first.
    server: (
      text: string,
      accountId: string | null,
      field?: SearchField
    ) => Promise<MessageSummary[]>
  }
  compose: {
    open: (payload?: Partial<ComposePayload>) => Promise<void>
    /**
     * Schedules the send rather than performing it. The message goes out after
     * a short hold so it can be taken back; the composer closes immediately
     * either way. Resolving does **not** mean the mail has left.
     */
    scheduleSend: (payload: ComposePayload, sendAt?: number) => Promise<ScheduledSend>
    /**
     * Take back a send that has not gone yet. `cancelled: false` means the hold
     * had already expired and the message is away — the one answer the UI must
     * not paper over.
     */
    cancelSend: (scheduledId: string) => Promise<CancelSendResult>
    /** Fires when a held send has actually gone. */
    onSent: (callback: (subject: string) => void) => () => void
    /**
     * Fires when a held send **failed**, in the main window.
     *
     * A send runs on the scheduler after the undo window closes, long after the
     * composer has gone, so a failure has nowhere of its own to appear. It used
     * to reach only `console.warn`: the message stayed in Drafts, the user was
     * told nothing, and the last thing they saw was the send being accepted.
     *
     * `keptAsDraft` is whether the message is recoverable — `performSend`
     * deletes the draft only once the send resolves, so a failure normally
     * leaves it there, but a send with no draft behind it cannot promise that.
     */
    onSendFailed: (
      callback: (info: { subject: string; message: string; keptAsDraft: boolean }) => void
    ) => () => void
    /**
     * Fires in the **main** window when a send is scheduled. The composer has
     * already closed by then, so this is where the offer to take it back lives.
     */
    onSendScheduled: (
      callback: (info: {
        scheduledId: string
        dueAt: number
        subject: string
        /** True for a message timed for later, false for the ten-second hold. */
        scheduled: boolean
      }) => void
    ) => () => void
    /**
     * Fires when a timed send is taken out of the queue because its draft was
     * opened for editing.
     */
    onSendUnscheduled: (callback: (draftId: string) => void) => () => void
    pickAttachments: () => Promise<AttachmentDraft[]>
    statAttachments: (paths: string[]) => Promise<AttachmentDraft[]>
    // Resolves a dropped File to a path *and* approves it for attachment; the
    // renderer never gets to name a file itself. Returns null for anything that
    // is not a real dropped file.
    attachDroppedFile: (file: File) => Promise<AttachmentDraft | null>
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
    /**
     * Something threw where nothing caught it. The process state is unknown
     * afterwards, so the user is told once and left to choose when to restart.
     */
    /**
     * A passing message from main for the main window's toast — used when the
     * thing worth reporting happened somewhere the user is not looking, e.g. a
     * draft kept as the compose window closed.
     */
    onToast: (callback: (message: string) => void) => () => void
    onUnexpectedError: (callback: (message: string) => void) => () => void
    /**
     * The renderer fell over. Written to `renderer-errors.log` in the profile
     * directory, because a render error blanks the window while leaving the
     * process alive — nothing crashes, so without this nothing is recorded and
     * the only evidence is a console the user never opened.
     */
    reportRendererError: (report: RendererErrorReport) => Promise<void>
    /** Whether OS-level encryption (safeStorage) is available for stored secrets. */
    getSecureStorageStatus: () => Promise<{ available: boolean }>
    /**
     * What this desktop supports, so Settings can disable a control rather than
     * offer one that silently does nothing.
     */
    getPlatformCapabilities: () => Promise<PlatformCapabilities>
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
    /**
     * The sender lists. Each add/remove returns the resulting list so the
     * renderer can replace its copy without a second read.
     *
     * `blockSender` rejects one of the user's own addresses: every Sent row is
     * from them, so blocking it would hide their own mail.
     */
    muteSender: (email: string) => Promise<string[]>
    unmuteSender: (email: string) => Promise<string[]>
    unblockSender: (email: string) => Promise<string[]>
    revokeSenderImages: (email: string) => Promise<string[]>
    allowSenderImages: (email: string) => Promise<string[]>
    blockSender: (email: string) => Promise<string[]>
  }
  oauth: {
    /** Never returns credential values — only whether each provider is usable. */
    getStatus: () => Promise<OAuthConfigStatus>
    saveCredentials: (values: Partial<Record<OAuthCredentialKey, string>>) => Promise<OAuthConfigStatus>
  }
  drafts: {
    /**
     * Create or update a draft, returning its id — or null when the composer is
     * empty, in which case an existing draft is deleted rather than left blank.
     */
    save: (payload: Partial<ComposePayload>, draftId?: string) => Promise<string | null>
    /** Drafts for an account, newest first. */
    list: (accountId: string) => Promise<DraftSummary[]>
    /** Reopen a draft in the composer. */
    open: (draftId: string) => Promise<void>
    discard: (draftId: string) => Promise<void>
  }
  contacts: {
    /**
     * Addresses this account has corresponded with, matching `query`, best
     * first. Scoped to the account so a personal contact cannot be suggested
     * while composing from a work address.
     */
    suggest: (accountId: string, query: string, limit?: number) => Promise<ContactSuggestion[]>
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
    /**
     * `force` re-runs the model over every message in scope, ignoring the
     * per-message cache. Without it a sweep only sends mail it has never
     * analyzed, so a re-sweep of an unchanged folder spends nothing.
     */
    sweep: (
      folderId: string | 'unified',
      scope: SweepScope,
      force?: boolean
    ) => Promise<AiSweepResult>
    getTasks: (folderId: string | 'unified') => Promise<SweepResult>
    // Force one email into the current task list, using the model to identify
    // the action. Persists as a manual task that sweeps won't remove.
    flagAsTask: (folderId: string | 'unified', messageId: string) => Promise<AiSweepResult>
    // Cached-only AI analysis (never calls the API); null when none is stored.
    getCachedAnalysis: (messageId: string) => Promise<AiAnalysis | null>
    /**
     * Summarize a whole conversation. `threadId` is the thread *key* the reader
     * groups on — `COALESCE(thread_id, id)`, the same value passed to
     * `messages.getThread`. A fresh cached summary is returned without calling
     * the API; a stale one is regenerated, since reaching this channel means the
     * user clicked. `force` regenerates regardless.
     */
    analyzeThread: (
      accountId: string,
      threadId: string,
      force?: boolean
    ) => Promise<AiThreadAnalysisResult>
    /** Cached-only conversation summary (never calls the API); null when none. */
    getCachedThreadAnalysis: (
      accountId: string,
      threadId: string
    ) => Promise<AiThreadAnalysis | null>
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
