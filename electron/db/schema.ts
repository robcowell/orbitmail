import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider', { enum: ['gmail', 'o365', 'imap', 'pop3'] }).notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  tokenBlob: text('token_blob').notNull(),
  createdAt: integer('created_at').notNull(),
  syncDays: integer('sync_days').notNull().default(90)
})

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    imapPath: text('imap_path').notNull(),
    name: text('name').notNull(),
    type: text('type', {
      enum: ['inbox', 'sent', 'drafts', 'trash', 'junk', 'custom']
    }).notNull(),
    unreadCount: integer('unread_count').notNull().default(0),
    isVirtualView: integer('is_virtual_view', { mode: 'boolean' }).notNull().default(false),
    uidValidity: integer('uid_validity'),
    highestSyncedUid: integer('highest_synced_uid').notNull().default(0),
    lastSyncAt: integer('last_sync_at'),
    initialSyncComplete: integer('initial_sync_complete', { mode: 'boolean' })
      .notNull()
      .default(false),
    // CONDSTORE highest MODSEQ seen for this folder, as a string (64-bit; can
    // exceed Number.MAX_SAFE_INTEGER). Drives incremental flag reconciliation.
    highestModseq: text('highest_modseq'),
    // Server-side message count last seen (STATUS MESSAGES). A drop signals an
    // expunge; persisted so deletions made while the app was closed are caught.
    serverMessageCount: integer('server_message_count')
  },
  (t) => [index('folders_account_idx').on(t.accountId)]
)

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    folderId: text('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    uid: integer('uid').notNull(),
    messageId: text('message_id'),
    // RFC 5322 threading headers + a derived thread key. `references` is the raw
    // space-separated Message-ID chain; `threadId` groups a conversation.
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    threadId: text('thread_id'),
  from: text('from_addr').notNull(),
  to: text('to_addr').notNull(),
    cc: text('cc'),
    subject: text('subject').notNull(),
    snippet: text('snippet').notNull(),
    date: integer('date').notNull(),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull().default(false),
    flagColor: text('flag_color', {
      enum: ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray']
    }),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    bodyHtml: text('body_html'),
    bodyText: text('body_text'),
    aiAnalysis: text('ai_analysis'),
    aiAnalysisAt: integer('ai_analysis_at'),
    // Cached per-message sweep extraction: JSON array of { task, priority }.
    // Lets a re-sweep skip messages already analyzed (incremental sweep). Null
    // means "never analyzed"; an empty array means "analyzed, no tasks".
    sweepCache: text('sweep_cache'),
    sweepCacheAt: integer('sweep_cache_at')
  },
  (t) => [
    index('messages_folder_date_idx').on(t.folderId, t.date),
    index('messages_account_date_idx').on(t.accountId, t.date),
    index('messages_thread_idx').on(t.accountId, t.threadId),
    index('messages_message_id_idx').on(t.messageId)
  ]
)

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  messageId: text('message_id')
    .notNull()
    .references(() => messages.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  localPath: text('local_path')
})

export const appPreferences = sqliteTable('app_preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

// Persisted AI inbox-sweep tasks. Rows are scoped to the folder the sweep ran
// on ('unified' for the combined inbox). `open` rows are replaced on each sweep;
// `completed` rows persist so the user keeps a history and the model can be told
// not to resurface work already done. `id` is a stable dedupe key derived from
// the source message + normalized task text.
export const sweepTasks = sqliteTable(
  'sweep_tasks',
  {
    folderId: text('folder_id').notNull(),
    id: text('id').notNull(),
    task: text('task').notNull(),
    priority: text('priority', { enum: ['urgent', 'high', 'medium', 'low'] }).notNull(),
    sourceMessageId: text('source_message_id').notNull(),
    sourceSubject: text('source_subject').notNull(),
    sourceFrom: text('source_from').notNull(),
    status: text('status', { enum: ['open', 'completed'] })
      .notNull()
      .default('open'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at')
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.id] }),
    index('sweep_tasks_folder_idx').on(t.folderId)
  ]
)
