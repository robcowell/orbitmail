import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  provider: text('provider', { enum: ['gmail', 'o365'] }).notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  tokenBlob: text('token_blob').notNull(),
  createdAt: integer('created_at').notNull()
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
    unreadCount: integer('unread_count').notNull().default(0)
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
  from: text('from_addr').notNull(),
  to: text('to_addr').notNull(),
    cc: text('cc'),
    subject: text('subject').notNull(),
    snippet: text('snippet').notNull(),
    date: integer('date').notNull(),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull().default(false),
    hasAttachments: integer('has_attachments', { mode: 'boolean' }).notNull().default(false),
    bodyHtml: text('body_html'),
    bodyText: text('body_text')
  },
  (t) => [
    index('messages_folder_date_idx').on(t.folderId, t.date),
    index('messages_account_date_idx').on(t.accountId, t.date)
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
