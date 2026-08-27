import { sqliteTable, text, integer, index, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider', { enum: ['gmail', 'o365', 'imap', 'pop3'] }).notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  tokenBlob: text('token_blob').notNull(),
  createdAt: integer('created_at').notNull(),
  syncDays: integer('sync_days').notNull().default(90),
  // Sanitized HTML appended to the editable body of a new message. NULL or
  // empty means this account has no signature.
  signature: text('signature')
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
    // Plain-text projection of the body (text/plain, or stripped HTML), so
    // search scans ~10x less data than raw body_html and matches content, not
    // markup. Populated on upsert; backfilled in the background for old rows.
    searchText: text('search_text'),
    // POP3 only: the server's UIDL string, which is the protocol's actual
    // message identity. `uid` is a 32-bit hash of it and can collide.
    serverUid: text('server_uid'),
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
    index('messages_message_id_idx').on(t.messageId),
    // Thread listing. The thread key is COALESCE(thread_id, id), so these are
    // expression indexes; see the matching CREATE INDEX statements in
    // db/index.ts, which are what actually run.
    index('messages_thread_key_date_idx').on(
      t.accountId,
      sql`COALESCE(thread_id, id)`,
      t.date
    ),
    index('messages_folder_thread_key_idx').on(
      t.folderId,
      t.accountId,
      sql`COALESCE(thread_id, id)`,
      t.isRead
    )
  ]
)

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    messageId: text('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    size: integer('size').notNull(),
    localPath: text('local_path'),
    // An image mailparser has already embedded in body_html as a data: URI —
    // a signature logo, not something the sender attached. The row is kept
    // (see isInlineImagePart) so part resolution still counts positions the
    // way the server ordered them; the reader collapses these out of sight.
    isInline: integer('is_inline', { mode: 'boolean' }).notNull().default(false)
  },
  // Every attachment lookup is by message_id, and the ON DELETE CASCADE above
  // needs it too — without this index each parent delete is a full scan, so
  // pruning N messages is N scans.
  (t) => [index('attachments_message_id_idx').on(t.messageId)]
)

export const appPreferences = sqliteTable('app_preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

// Persisted AI inbox-sweep tasks. Rows are scoped to the folder the sweep ran
// on ('unified' for the combined inbox). `open` rows are replaced on each sweep;
// `completed` rows persist so the user keeps a history and the model can be told
// not to resurface work already done. `id` is a stable dedupe key derived from
// the source message + normalized task text.
/**
 * Work the app owes the future: a send held back so it can be undone, a send
 * timed for later, a snoozed message due to come home.
 *
 * Persisted rather than kept in memory because the app is not always running —
 * quitting inside an undo-send window must not lose the message, and a snooze
 * set on Friday has to survive until Monday. Anything overdue at startup runs
 * then, which is the honest bargain for a desktop client with no server-side
 * scheduler: it happens when the app is next open, not necessarily on time.
 */
export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['send', 'snooze'] }).notNull(),
    /** When it should happen. Epoch ms. */
    dueAt: integer('due_at').notNull(),
    /** Kind-specific JSON: a draft id for a send, a Message-ID for a snooze. */
    payload: text('payload').notNull(),
    createdAt: integer('created_at').notNull()
  },
  (table) => ({
    dueIdx: index('scheduled_actions_due_idx').on(table.dueAt)
  })
)

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
    // 'sweep' = extracted by an automatic sweep (replaced wholesale each run);
    // 'manual' = the user force-flagged the source email, so it must survive
    // re-sweeps (replaceOpenSweepTasks only clears 'sweep' rows).
    source: text('source', { enum: ['sweep', 'manual'] })
      .notNull()
      .default('sweep'),
    createdAt: integer('created_at').notNull(),
    completedAt: integer('completed_at')
  },
  (t) => [
    primaryKey({ columns: [t.folderId, t.id] }),
    index('sweep_tasks_folder_idx').on(t.folderId)
  ]
)

// Addresses collected from mail, per account, for compose autocomplete. There
// is no address book to sync and no contacts UI — a row appears because the
// account corresponded with it. `address` is the lowercased mailbox part, which
// is the identity; `name` is the best display name seen for it. The two counts
// are kept apart because they mean different things when ranking: sentCount is
// people the user chose to write to, seenCount is people who turned up in their
// mail, and a stranger who mailed once must never outrank a real correspondent.
// POP3 messages that fall outside the sync window, remembered so they are not
// re-examined on every poll. Keyed by UIDL, which is the only stable identity a
// POP3 maildrop offers — message *numbers* are per-session and shift whenever
// anything is deleted, so a high-water mark over them would be wrong.
//
// The message's own date is stored rather than a "skipped" flag: widening the
// sync window then brings a remembered message back into range by itself, with
// nothing to invalidate. A flag would need clearing whenever syncDays changed,
// and the version that forgot to do that would silently never fetch old mail
// again.
export const pop3Skipped = sqliteTable(
  'pop3_skipped',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    serverUid: text('server_uid').notNull(),
    messageDate: integer('message_date').notNull()
  },
  (t) => [primaryKey({ columns: [t.accountId, t.serverUid] })]
)

// A cached AI summary of one conversation, keyed by the same thread key the
// reader groups on — `COALESCE(thread_id, id)`, scoped per account.
//
// The account FK is the only one available: a thread key is *derived*, not a key
// of any table, so nothing can enforce that a row's conversation still exists.
// `regroupThreadsForAccount` re-links an account's threads after every sync that
// ingests mail, and a late reply bridging two conversations makes one of the two
// keys vanish — leaving a row nothing will ever ask for again. Pruning is
// therefore hand-rolled, and hangs off regroup; see `pruneOrphanedThreadAnalysis`.
//
// `message_count` and `latest_message_id` are stored together because either
// alone misses a real change: a count alone misses a delete plus an arrival, and
// a latest id alone misses an older message backfilled by a server-side search.
// `analyzed_count` is how many of them actually reached the model, so the UI can
// say "the 12 most recent of 30" rather than implying the whole thread was read.
export const threadAnalysis = sqliteTable(
  'thread_analysis',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').notNull(),
    json: text('json').notNull(),
    generatedAt: integer('generated_at').notNull(),
    messageCount: integer('message_count').notNull(),
    analyzedCount: integer('analyzed_count').notNull(),
    latestMessageId: text('latest_message_id').notNull()
  },
  (t) => [primaryKey({ columns: [t.accountId, t.threadId] })]
)

export const contacts = sqliteTable(
  'contacts',
  {
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    address: text('address').notNull(),
    name: text('name'),
    sentCount: integer('sent_count').notNull().default(0),
    seenCount: integer('seen_count').notNull().default(0),
    lastSeenAt: integer('last_seen_at').notNull().default(0)
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.address] }),
    index('contacts_account_idx').on(t.accountId)
  ]
)

// Locally-saved compose drafts.
//
// Deliberately NOT rows in `messages`. A draft has no server uid, and the
// expunge reconciliation in imap-sync deletes any local row whose uid is absent
// from the server's list — so a draft parked in the Drafts folder would be
// deleted by the next sync of that folder. Keeping them in their own table also
// keeps them clear of `UNIQUE(folder_id, uid)`.
//
// Scoped to an account rather than a folder: the Drafts *folder* is resolved at
// query time, so a draft survives the folder being renamed, re-typed, or not
// existing yet.
export const drafts = sqliteTable(
  'drafts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    to: text('to_addr').notNull().default(''),
    cc: text('cc').notNull().default(''),
    bcc: text('bcc').notNull().default(''),
    subject: text('subject').notNull().default(''),
    bodyHtml: text('body_html').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    // The collapsed quote of the message being replied to or forwarded, kept
    // separate from the editable body exactly as ComposePayload does.
    quotedHtml: text('quoted_html'),
    quotedText: text('quoted_text'),
    inReplyTo: text('in_reply_to'),
    references: text('references'),
    mode: text('mode'),
    originalMessageId: text('original_message_id'),
    /** JSON array of absolute paths. Re-approved on restore, if they still exist. */
    attachmentPaths: text('attachment_paths'),
    updatedAt: integer('updated_at').notNull()
  },
  (t) => [index('drafts_account_idx').on(t.accountId)]
)
