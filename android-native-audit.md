# Orbit Mail — Android Native Port: Step 0 Repo Audit

**Purpose:** Introspection pass over the existing Electron app (v0.1.0) before any Kotlin is written, as required by Step 0 of the Android build plan. This documents the *behavioural spec* — the protocol logic, data model, and IPC contract that are the reusable assets — and flags, per subsystem, **what maps cleanly to Android** vs. **what needs rethinking** (chiefly Android's process lifecycle, OAuth redirect model, and secret storage).

**Method:** Every file under `electron/` and `shared/` was read (IPC handlers in `main.ts`, all `electron/services/*`, `electron/db/*`), cross-referenced against `README.md`, `DEVELOPERS.md`, and `TODO.md`. Nothing here is inferred from the UI layer beyond the IPC contract it consumes.

**Bottom line:** This is a genuine rewrite, not a transliteration. The architecture ports 1:1 (on-device SQLite cache + direct IMAP/SMTP sockets + OAuth + optional AI) because Android, unlike a browser, is not socket-sandboxed. The single biggest real difference is **background execution** (Step 2 of the plan), followed by the **OAuth redirect mechanism** and **secret storage**, both of which are Electron/Node-specific today.

---

## 1. Stack inventory (what's being replaced)

| Concern | Electron/Node today | Android/Kotlin target | Port difficulty |
|---|---|---|---|
| Runtime shell | Electron 39, electron-vite | Android app (Kotlin) | rewrite |
| UI | React 18 + Zustand + Phosphor | Jetpack Compose + ViewModel/StateFlow | rewrite (declarative→declarative, closest analog) |
| Local DB | `better-sqlite3` + Drizzle ORM + FTS5 | Room (SQLite) + FTS4/5 | **schema ports 1:1**, query code rewritten |
| IMAP | `imapflow` (sync, IDLE, move, flags, CONDSTORE) | Jakarta/Angus Mail, or K-9/JavaMail-derived client | **highest-risk** (Step 6.1 spike) |
| SMTP | `nodemailer` (OAuth2 + password) | Jakarta Mail `Transport` (SASL XOAUTH2) | medium |
| MIME parsing | `mailparser` (`simpleParser`) | Jakarta Mail `MimeMessage`/`MimeMultipart` | medium |
| POP3 | `node-pop3` | — (out of scope v1) | n/a |
| OAuth (Google) | `google-auth-library` `OAuth2Client` **+ client secret** (confidential client) | AppAuth-Android **public client + PKCE, no secret** | **rethink** |
| OAuth (Microsoft) | `@azure/msal-node` `PublicClientApplication` + manual token-cache scraping | MSAL Android (or AppAuth) | **rethink** (drop the scraping hack) |
| OAuth redirect | loopback HTTP server on `127.0.0.1:<ephemeral>` (`node:http`) | custom-scheme / App Link redirect + Chrome Custom Tabs | **rethink** (no loopback on Android) |
| Secret storage | Electron `safeStorage` (OS keychain) w/ plaintext base64 fallback | Android Keystore + `EncryptedSharedPreferences`/`EncryptedFile` | **rethink** (never fall back to plaintext) |
| AI | `@anthropic-ai/sdk` `messages.parse()` + JSON-schema structured output, `claude-opus-4-8` | OkHttp/Ktor → Messages REST API, manual schema validation | medium |
| Background sync | `setInterval` polls + persistent IDLE socket in main process | WorkManager (poll) + foreground service (IDLE) | **rethink** (Step 2 — the real difference) |
| HTML sanitization | DOMPurify (renderer) | Compose WebView + a JVM sanitizer, or render sanitized HTML | medium |
| Attachments dir | `~/.config/orbit-mail/data/attachments/` (flat) | `context.filesDir/attachments` (flat) + `FileProvider` for share-out | easy |
| Notifications | Electron `Notification` + taskbar badge | `NotificationManager` + (optional) launcher badge | easy |
| mailto handler | `app.setAsDefaultProtocolClient('mailto')` | `intent-filter` for `mailto:` scheme | easy |

---

## 2. Data model → Room entities

The SQLite schema is the direct target for Room entity design. Both the canonical Drizzle schema (`electron/db/schema.ts`) and the raw `CREATE TABLE` + migration path (`electron/db/index.ts`) were read. Column-for-column, the schema ports 1:1. Types below are the *storage* types (SQLite affinity); booleans are stored as `INTEGER 0/1`, timestamps as `INTEGER` epoch-millis, ids as `TEXT` (app-generated).

### 2.1 Tables

**`accounts`** — one row per account.
`id` (PK, text) · `provider` (`gmail|o365|imap|pop3`) · `email` · `display_name` · `token_blob` (text — encrypted credential JSON, see §6) · `created_at` (int) · `sync_days` (int, default **90**).
→ Room `@Entity`. **On Android, `token_blob` should not live in Room** — move it to `EncryptedSharedPreferences`/Keystore, keyed by `id`, leaving the DB row credential-free (see §6).

**`folders`** — one row per mailbox per account.
`id` (PK) · `account_id` (FK→accounts, cascade) · `imap_path` · `name` · `type` (`inbox|sent|drafts|trash|junk|custom`) · `unread_count` (int) · `is_virtual_view` (bool) · `uid_validity` (int, nullable) · `highest_synced_uid` (int, default 0) · `last_sync_at` (int, null) · `initial_sync_complete` (bool) · `highest_modseq` (**text** — 64-bit MODSEQ can exceed JS `Number.MAX_SAFE_INTEGER`; keep as string/`Long` in Kotlin) · `server_message_count` (int, null).
Index: `folders_account_idx(account_id)`.

**`messages`** — the bulk table.
`id` (PK) · `folder_id` (FK, cascade) · `account_id` (FK, cascade) · `uid` (int) · `message_id` (text, null) · `in_reply_to` (text, null) · `references` (text, null — raw space-separated Message-ID chain) · `thread_id` (text, null) · `from_addr` · `to_addr` · `cc` (null) · `subject` · `snippet` · `date` (int) · `is_read` · `is_starred` · `flag_color` (`red|orange|yellow|green|blue|purple|gray`, null) · `has_attachments` · `body_html` (null) · `body_text` (null) · `ai_analysis` (text/JSON, null) · `ai_analysis_at` (int, null) · `sweep_cache` (text/JSON array, null) · `sweep_cache_at` (int, null).
Indexes: `messages_folder_date_idx(folder_id, date)` · `messages_account_date_idx(account_id, date)` · `messages_thread_idx(account_id, thread_id)` · `messages_message_id_idx(message_id)` · **unique** `messages_folder_uid_idx(folder_id, uid)` · partial `messages_folder_unread_idx(folder_id) WHERE is_read = 0`.
→ Room supports composite + unique indices via `@Index`. **Partial indexes** (`WHERE is_read = 0`) are not expressible in Room annotations — create them in a `RoomDatabase.Callback`/migration `execSQL`. Same for the FTS trigger wiring.

**`attachments`** — metadata rows; content fetched lazily (§8).
`id` (PK) · `message_id` (FK, cascade) · `filename` · `mime_type` · `size` (int) · `local_path` (text, null until downloaded).

**`app_preferences`** — generic key/value store (`key` PK, `value` text). Holds several logical records:
- `app_state` — the whole `PersistedAppState` JSON blob (UI prefs, window, muted/blocked senders, lastSyncAt, mailto flag).
- `ai_api_key` — encrypted Anthropic key (separate row).
- `fts_index_v2` — one-time FTS rebuild guard.
- `ai_sweep_meta` — per-folder sweep metadata (last run, count, scope).
- `thread_backfill_v1` — one-time thread-id backfill guard.
→ On Android, `app_state`/prefs map more naturally to **DataStore**; `ai_api_key` must go to Keystore, not a KV row. A `preferences` Room table can stay for parity if preferred.

**`sweep_tasks`** — persisted AI task list. Composite PK `(folder_id, id)`.
`folder_id` · `id` (stable dedupe key) · `task` · `priority` (`urgent|high|medium|low`) · `source_message_id` · `source_subject` · `source_from` · `status` (`open|completed`, default `open`) · `created_at` · `completed_at` (null).
Index: `sweep_tasks_folder_idx(folder_id)`. `folder_id` is either a real folder id or the literal `'unified'`.

**`messages_fts`** — FTS5 virtual table: `(message_id UNINDEXED, subject, snippet, body_text)`, `content=''`, `contentless_delete=1`. Maintained on every upsert. **Note:** built on sync but the README states the *query path currently uses scope-aware `LIKE`, not FTS* (LIKE also covers From/To, which the FTS table doesn't store). See §9 — the Android port can either replicate the LIKE query or actually use FTS (extending it to sender/recipient columns).

### 2.2 Migration behaviour to preserve (or discard)

`electron/db/index.ts` carries an accreted set of additive `ALTER TABLE` migrations (adding `uid_validity`, `highest_synced_uid`, `highest_modseq`, `server_message_count`, `is_virtual_view`, `flag_color`, `ai_analysis`, `sweep_cache`, `in_reply_to`, `references`, `thread_id`, `sync_days`) plus two one-time backfills (`thread_backfill_v1`, `fts_index_v2`) and tuned pragmas (WAL, `synchronous=NORMAL`, 16 MB cache, 256 MB mmap, 5s busy_timeout).
→ **The Android port starts from the *final* schema** — none of these historical migrations need porting (there is no existing Android DB to upgrade). Room's own migration system takes over from v1. The pragmas are largely Room-managed defaults; WAL is on by default in Room, and the busy_timeout concern is moot under Room's single-writer coordination.

---

## 3. IPC surface = the behavioural spec

The full `OrbitMailAPI` contract lives in `shared/types.ts` and is bridged in `electron/preload.ts`; every handler is implemented in `electron/main.ts` (delegating to services). **This is the reusable spec** — the Kotlin app must reproduce each operation's *behaviour*, even though the transport (typed IPC over contextBridge) becomes in-process ViewModel/repository calls with no serialization boundary. Enumerated below, grouped, with the behaviour that matters.

### accounts
- `list()` → all accounts.
- `add('gmail'|'o365')` → runs OAuth (§5), `saveAccount`, then **full refresh + restart IDLE monitoring**.
- `addManual(ManualAccountInput)` → live-validates IMAP/POP3 + SMTP round-trip *before* saving (§10), then refresh + restart IDLE.
- `autodetect(email)` → Mozilla autoconfig + preset table (§10).
- `remove(accountId)` → delete row (cascades folders/messages/attachments), close pooled connection, restart IDLE.
- `getInfo(accountId)` → aggregates folder/message/unread counts + local storage bytes + attachment counts.
- `updateDisplayName` · `updateSyncDays` (the latter re-prunes out-of-window mail).

### folders
- `list(accountId?)` · `create(accountId, name)` (creates `INBOX<delim><name>` server-side then upserts) · `export(folderId)` (writes an **mbox** file — `From ` line + raw RFC822 per message) · `emptyTrash` · `emptyJunk` (server `messageDelete({all})` + local clear) · `markAllRead(folderId)` (local + server `\Seen`).

### messages
- `list(folderId|'unified', limit?, offset?, unreadOnly?)` · `count(...)` — flat rows; `'unified'` spans accounts' inboxes.
- `listThreads(...)` · `countThreads(...)` — one row per conversation in the folder (window-function aggregates: latest message, participant names, unread flag, count).
- `getThread(accountId, threadId)` → **whole conversation across folders** (Sent interleaved), scoped by `(account_id, thread_id)`.
- `get(messageId)` → full `MessageDetail` (body + attachments).
- `markRead` · `toggleStar` · `setFlag` — write local **then** propagate to server (`\Seen`/`\Flagged`). Optimistic in the UI.
- `delete` · `deleteMany([{id, targetFolderId}])` — server delete/move first, then local delete, then a single reconciliation poll. `move` · `copy` — server op then poll.

### sync
- `refresh(accountId?)` → one account or all. `getStatus()` → `SyncStatus`.
- `onStatusChange(cb)` · `onMessagesUpdated(cb)` — **push channels** (main→renderer events). On Android these become `StateFlow`/`SharedFlow` the UI collects; no IPC event bus needed.

### search
- `query(text, accountId, field?, limit?)` → local scope-aware search.
- `server(text, accountId, field?)` → **live IMAP search fallback** (Gmail `X-GM-RAW` over All Mail, else `from/to/subject/body` SEARCH over INBOX), imports matches into the DB so they open like cached mail. `[]` for POP3.

### compose
- `open(payload?)` (opens a compose window — on Android a compose screen/route) · `send(payload)` (SMTP send then Sent-only sync) · `pickAttachments` / `statAttachments` (native file dialog → Android SAF `ACTION_OPEN_DOCUMENT`) · `getPathForFile` (Electron `webUtils` — replaced by content-URI handling) · `close` · `onOpen(cb)`.

### attachments
- `download(id)` → ensure local, return path. `open(id)` → download + open with OS handler (Android: `Intent.ACTION_VIEW` via `FileProvider`). `saveAs(id)` · `saveAll(messageId)` → save dialog(s) (Android: `ACTION_CREATE_DOCUMENT` / tree URI).

### preferences
- `get()` · `saveUi(partial)` · `save(partialState)` · `setHandleMailtoLinks(bool)` (also toggles OS protocol registration) · `muteSender(email)` · `blockSender(email)`.

### ai (all no-op unless a key is set)
- `analyze(messageId, force?, includeAttachments?)` · `draftReply(messageId, tone, mode?)` · `sweep(folderId, scope)` · `getTasks(folderId)` (pure DB read) · `exportTasks(markdown, name)` · `completeTask` · `reopenTask` · `getStatus()` · `setApiKey` · `clearApiKey`. Details in §7.

### shell / print / app
- `shell.openExternal(url)` → Android `Intent.ACTION_VIEW` (open links in browser).
- `print.document(html)` → renders sanitized HTML in a script-free offscreen window + OS print dialog. Android: `PrintManager` + a WebView print adapter (JS disabled).
- `app.onNeedsAccount(cb)` → fired when a `mailto:` arrives with no account configured.

**Contract types to re-model in Kotlin** (from `shared/types.ts`): `Provider`, `FolderType`, `SearchField`, `ConnectionSecurity`, `ServerConfig`, `ManualAccountInput`, `AutodetectResult`, `Account`, `AccountInfo`, `Folder`, `FlagColor`, `MessageSummary`, `Attachment`, `ThreadSummary`, `MessageDetail`, `ComposePayload`, `AttachmentDraft`, `SyncStatus`, `UiPreferences`, `PersistedAppState`, `AiAnalysis`, `SweepTask`/`CompletedTask`/`SweepResult`, `ReplyDraft`, `DraftTone`, `SweepScope`, `AiPriority`. These are clean Kotlin `data class`/`sealed`/`enum` targets.

---

## 4. Sync engine — the crux of the port (`imap-sync.ts`, `imap-idle.ts`, `imap-pool.ts`)

This is the largest reusable asset and the highest-risk area (Step 6.1 spike). The *strategy* below must be reproduced regardless of which Kotlin IMAP library wins.

### 4.1 Provider config & folder typing
- Hardcoded servers: Gmail `imap.gmail.com:993` / `smtp.gmail.com:587`; O365 `outlook.office365.com:993` / `smtp.office365.com:587`. Manual accounts carry their own `ServerConfig`.
- Folder type detection: SPECIAL-USE flags first (`\Inbox`/`\Sent`/`\Drafts`/`\Trash`/`\Junk`), then a name map (`INBOX`, `Sent Mail`/`Sent Items`/`Sent`, `Drafts`, `Trash`/`Deleted`/`Deleted Items`, `Junk`/`Spam`), else `custom`.
- Gmail "virtual view" folders (`[Gmail]/All Mail|Important|Starred|Snoozed`) are flagged `is_virtual_view` and excluded from unread-badge math (`shared/folders.ts`).
- Folders are synced in a **priority order** (Inbox → Sent → Drafts → Trash → Junk → custom, then alphabetical).

### 4.2 Initial vs. incremental sync (per folder)
- **Initial sync:** up to `SYNC_BATCH_SIZE = 200` most-recent UIDs. Selection prefers server `SORT ['REVERSE DATE'] SINCE <cutoff>`, falls back to `SEARCH SINCE`, then `SORT ALL`, then `SEARCH ALL` — degrading gracefully as server capabilities allow. **Kotlin note:** the chosen IMAP lib must expose SORT/SEARCH with SINCE; if not, fall back to fetching recent UIDs by range.
- **Incremental sync:** compares server `uidNext` to local `highest_synced_uid`. If `uidNext <= maxLocalUid + 1`, nothing new — just refresh unread + `uidValidity`. Otherwise `SEARCH UID <maxLocalUid+1>:*`, minus UIDs already present (`getFolderUidSet`).
- **UIDVALIDITY change:** if server `uidValidity` differs from stored, the folder is re-synced from scratch (`clearFolderMessages` then refetch) — but only if there are UIDs to fetch (guards against wiping on a transient empty result).
- **Fetch + parse:** `FETCH (UID ENVELOPE FLAGS BODY[])` (full source), parsed with `mailparser` into `from`/`to`/`cc`/`subject`/`bodyText`/`bodyHtml`/`snippet`(120 chars)/`date`/flags/attachments/threading headers. Messages outside the sync window are skipped unless `ignoreWindow` (server-search import). The whole folder batch is **committed in one transaction** (WAL).
- **Sync window:** per-account `sync_days` (default 90; `<= 0` = unlimited). `pruneMessagesOutsideSyncWindow` drops older mail after each account sync. (`sync-policy.ts` — pure, ports trivially.)

### 4.3 IMAP IDLE (`imap-idle.ts`) — near-realtime
- One **dedicated persistent connection per account**, separate from the pool, holding the **inbox** open. On `exists` → sync the folder; on `flags`/`expunge` → debounced (2s) flag+expunge reconcile. Auto-reconnects on error/close after 5s. POP3 skipped.
- **This is the piece that collides hardest with Android's lifecycle** (§11). Holding a live socket open requires a foreground service; it cannot run indefinitely in the background post-Android-8. The plan's Step 2 decision (foreground service while active / WorkManager poll fallback, exposed as a per-account setting) is the correct adaptation and mirrors AquaMail.

### 4.4 Connection pool (`imap-pool.ts`)
- One reused `ImapFlow` client per account for *mutations/sync* (distinct from the IDLE client), with a **per-account operation mutex** (promise chain — imapflow is single-op-at-a-time) and a 30s idle-close. So a batch of server ops shares one connection.
- **Kotlin note:** Jakarta Mail `Store`/`Folder` are also not thread-safe for concurrent ops; the same per-account serialization (a `Mutex` + a coroutine-scoped connection holder) reproduces this. Two connections per account (pool + IDLE) is the accepted trade.

### 4.5 Flag reconciliation & expunge detection
Incremental sync only fetches *new* UIDs, so `\Seen`/`\Flagged` changes to already-synced messages need a separate pass:
- **CONDSTORE fast path:** when the folder's `HIGHESTMODSEQ` advanced, `FETCH ... (CHANGEDSINCE <modseq>)` returns only changed messages. MODSEQ stored as a **string** (64-bit).
- **Full-scan fallback:** flags-only `FETCH 1:<maxUid> FLAGS` when CONDSTORE is unavailable or on first run.
- **Expunge:** not reliably tied to MODSEQ, so gated on server message count dropping (`STATUS MESSAGES`). Local UIDs no longer present server-side are deleted — with a guard against wiping the whole folder unless the server confirms it empty.
- Runs on a gentle cadence (5 min), on manual refresh, on launch, and debounced off IDLE flag/expunge events.
- **Kotlin note:** requires the IMAP lib to expose CONDSTORE/`CHANGEDSINCE` and per-message MODSEQ. **Confirm in the Step 6.1 spike** — if unsupported, fall back to periodic full flag scans (correct, just heavier).

### 4.6 Poll cadences (background timers today)
- POP3: 20s. IDLE-capable IMAP: 90s safety net (IDLE handles the inbox). Flag reconcile: 5 min. One immediate catch-up sync ~500ms after first paint.
- **Kotlin note:** these `setInterval` loops become **WorkManager periodic work** (min 15 min floor on Android — the 20s/90s cadences are *not* achievable in background without a foreground service). This is a real behavioural change the UI setting must make visible (Step 2). Foreground-active polling can be faster via a coroutine timer while the app is resumed.

### 4.7 Threading (`thread-util.ts`) — ports verbatim
`computeThreadId` precedence: **`References[0]`** (RFC thread root, present across Inbox+Sent) → `In-Reply-To` first token → own `Message-ID` → `subj:<normalizeSubject>` fallback. `normalizeSubject` strips repeated leading `Re:/Fwd:/Fw:`, collapses whitespace, lowercases. `thread_id` is the **raw Message-ID string** (angle brackets kept), not a hash. Grouping always scoped by `(account_id, thread_id)`. Pure functions — a direct Kotlin port.

### 4.8 Server-side mutations
`markMessageReadOnServer`, `toggleMessageStarredOnServer`, `deleteMessageOnServer`, `moveMessageOnServer` (`MOVE`), `copyMessageOnServer` (`COPY`), `appendToSentFolder` (`APPEND` with `\Seen`, cached Sent path), `syncSentFolder` (Sent-only resync after send), `exportMessageRawToTemp` (fetch `BODY[]` for forward-as-attachment/redirect). All lock the mailbox, run one op, release. POP3 rejects move/copy.

---

## 5. OAuth — scopes to register + Android rethink (`oauth-google.ts`, `oauth-microsoft.ts`, `oauth-loopback.ts`)

**Scopes are confirmed for the new Android client registrations (Step 3).**

### Google (Gmail) — verbatim scopes
- `https://mail.google.com/` (the **only** scope granting IMAP/SMTP; Google classes it **restricted** → CASA for public distribution)
- `openid`, `email`, `profile`

Auth params today: `access_type=offline`, `prompt=select_account consent`, `include_granted_scopes=true`. Token exchange via `google-auth-library`; **hard-fails if no refresh token**. Access-token scope is validated against `tokeninfo`; profile from `oauth2/v2/userinfo`.
**Android rethink:** the desktop flow is a **confidential client using `GOOGLE_CLIENT_SECRET`**. Android must use a **public client with PKCE and no secret** (AppAuth-Android) — an *Android* OAuth client ID tied to **package name + SHA-1 signing-cert fingerprint**. The secret must not ship in the APK.

### Microsoft (O365/Outlook) — verbatim scopes
- `openid`, `profile`, `email`, `offline_access`
- `https://outlook.office.com/IMAP.AccessAsUser.All`
- `https://outlook.office.com/SMTP.Send`

Public client via MSAL (`PublicClientApplication`), authority `https://login.microsoftonline.com/<tenant>` (`common` default). Scopes are **dynamically consented** — no portal API-permission pre-registration needed. Refresh tokens **rotate** and MSAL-node keeps them only in an in-memory cache, so the current code **scrapes the serialized token cache** to persist the refresh token itself.
**Android rethink:** **MSAL Android** (`com.microsoft.identity.client`) manages its own encrypted token cache natively — **drop the cache-scraping hack entirely**. Register a **mobile/native redirect URI**. `MICROSOFT_TENANT_ID=common` carries over.

### Redirect mechanism — no Android equivalent (rethink)
`oauth-loopback.ts` spins a `node:http` server on `127.0.0.1:<ephemeral>/callback` and opens the system browser via `shell.openExternal`. Microsoft's registered loopback URI is `http://127.0.0.1/callback` (Entra ignores the port). **None of this exists on Android.** Replace with:
- A **registered custom-scheme / `https` App Link redirect** (e.g. `com.orbitmail:/oauth2redirect`) captured by an `Activity` `intent-filter`.
- **Chrome Custom Tabs** (`CustomTabsIntent`) instead of `shell.openExternal`.
- **PKCE + `state` validation** handled by AppAuth/MSAL (the current loopback parses `state` but doesn't validate it — Android libs close that gap).

### Env-var config → Android build config
Today: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID` from `.env`, embedded at build time. On Android these become `BuildConfig`/manifest-placeholder values; **no secret bundled**. **The DEVELOPERS.md OAuth setup needs an Android-specific addendum** (different client type, package+SHA-1 for Google, native redirect URI for Microsoft) — this is a docs deliverable, not just a config swap, exactly as the plan's Step 3 anticipated.

---

## 6. Secret storage (`account-credentials.ts`) — rethink

- **Today:** credentials (`token_blob`) are `JSON.stringify`'d and encrypted with Electron `safeStorage` (OS keychain: Keychain/DPAPI/libsecret) → base64, stored in the `accounts.token_blob` column. The AI key uses the same mechanism in `app_preferences.ai_api_key`.
- **Security caveat to fix in the port:** when `safeStorage.isEncryptionAvailable()` is false, both fall back to **plaintext base64** (not encrypted). **On Android, never fall back to plaintext** — Keystore is always available.
- **Blob shape** (discriminated on `authType`):
  - OAuth: `{ authType:'oauth', accessToken, refreshToken?, expiryDate?, email, displayName }`
  - Password: `{ authType:'password', email, displayName, username, password, incoming:ServerConfig, outgoing:ServerConfig }`
- **XOAUTH2 assembly is *not* in this file.** `imapflow` builds the XOAUTH2 SASL string internally from `auth: { user, accessToken }` (see `createImapClient`), and `nodemailer` does the same from `auth: { type:'OAuth2', user, accessToken }`. **Kotlin note:** Jakarta Mail needs the XOAUTH2 SASL string supplied via the `mail.imap.sasl`/`mail.smtp.sasl` mechanism (or the manual `AUTH XOAUTH2 <base64(user=<email>^Aauth=Bearer <token>^A^A)>` string) — this is a concrete spike item.
- **Android target:** Android Keystore + `EncryptedSharedPreferences` (Jetpack Security) keyed by account id, or delegate OAuth tokens to MSAL/AppAuth's own secure stores. Keep the DB credential-free.

---

## 7. AI features (`ai-service.ts`) — ports cleanly, one SDK gap

- **Model:** `claude-opus-4-8` (preserve this id). SDK: `@anthropic-ai/sdk` `messages.parse()` with `jsonSchemaOutputFormat(...)` and `output_config.effort='low'`. Refusals detected via `stop_reason==='refusal'`.
  - **Kotlin gap:** no official Kotlin Anthropic SDK with structured-output helpers. Call the **Messages REST API** (OkHttp/Ktor) with a JSON-schema/tool response format and validate the parsed JSON manually. This is the one non-trivial AI port item; everything else (prompts, caching, persistence) is straight logic.
- **Key storage:** `app_preferences.ai_api_key`, encrypted (§6) → Keystore on Android.
- **Analyze** — schema `{summary, actionItems[], questions[], keyContext[]}`. System prompt distinguishes sender direction (FROM the user = not an action item; TO the user = an action). Body = `bodyText` or stripped HTML, truncated **8000 chars**, `max_tokens 2048`. **Cached** on `messages.ai_analysis`/`ai_analysis_at`; returned from cache unless `force` or `includeAttachments`.
  - **Attachments (opt-in):** per attachment, classified image (`png/jpeg/gif/webp` → base64 image block) / PDF (base64 document block) / textual (UTF-8, 8000-char cap, text block). Skips files > **4 MiB** or unsupported types (names surfaced as `skippedAttachments`). Localized via the same on-demand fetch as the UI.
- **Draft reply** — schema `{reply}`. Tone `brief|neutral|detailed` (default neutral). Grounded in up to **12** thread messages (labeled `FROM YOU`/`FROM <sender>`, 4000-char cap each). `max_tokens 2048`. **Never cached.**
- **Tasks sweep** — schema `{tasks:[{task, priority, sourceMessageId}]}`. Up to **40** messages, scope `unread|all`, body cap **1500** chars, `max_tokens 4096`.
  - **Incremental:** only messages with `sweep_cache IS NULL` are sent; each analyzed message's tasks (even empty) cached on its row → re-sweep of unchanged folder = **zero tokens**.
  - **Completed-task feedback:** completed tasks (cap 25, TTL 30 days) injected as "do NOT list these again"; dedupe key = `sourceMessageId + normalizedTaskText[:120]`.
  - Persisted to `sweep_tasks` (`open` replaced each sweep; `completed` retained); metadata in `app_preferences.ai_sweep_meta`. `getTasks` is a pure DB read.
- **Note:** this is app-side caching, **not** Anthropic prompt-caching (`cache_control`) — no `cache_control` breakpoints are used. Preserve as-is.

---

## 8. Attachments (`attachment-fetch.ts`) — easy port, storage rethink

- **Metadata/content split:** sync records only rows (`recordAttachmentsMetadata`: filename, mime default `application/octet-stream`, size, `local_path=null`). Content fetched on demand.
- **On-demand IMAP fetch (`ensureAttachmentLocal`):** cache hit if `local_path` exists on disk; else lock mailbox, fetch **BODYSTRUCTURE only**, resolve the target part by exact `filename+size` (fallback filename-only), `download(uid, partId)` to stream just that MIME part (transfer-decoding handled by imapflow). Fallback: fetch full source + `simpleParser` + match. **Kotlin note:** Jakarta Mail can fetch an individual `IMAPBodyPart` (`FetchProfile` for BODYSTRUCTURE, then part fetch), so this efficient design carries over.
- **Storage:** single flat dir (`getAttachmentsDir` = `<userData>/data/attachments/`), filename `${messageId}-${safeName}` (`[^\w.-]→_`). → Android `context.filesDir/attachments/`, same flat scheme. **Sharing out** (open/save) needs `FileProvider` content URIs, not raw paths. **Inbound compose attachments** arrive as **content URIs** (SAF), read via `ContentResolver` — not filesystem paths as today (`readFileSync`).

---

## 9. Search (`search-index.ts` + `db-service` query path)

- **Local:** an FTS5 `messages_fts` index is *maintained* on sync (`(message_id, subject, snippet, body_text)`), with query builders `buildFtsQuery` (prefix + AND) and `buildLikePattern`. **But the live query path uses scope-aware `LIKE`** over the `messages` table (README §Search), because LIKE also covers From/To which the FTS table omits. Scope (`SearchField`): `all` (From/To/Subject/Snippet/Body), `from`, `to`, `subject`, `body`; persisted in `UiPreferences`.
  - **Kotlin decision:** either replicate the `LIKE` query in Room (simplest, matches current behaviour) or use Room FTS4 and extend the FTS table with from/to columns to make FTS the real query path. Recommend replicating LIKE for parity in v1.
- **Server fallback (`searchServerMessages` in `imap-sync.ts`):** when local returns nothing (or on demand), live IMAP SEARCH — Gmail `X-GM-RAW` over All Mail, else `from/to/subject/body` keys over INBOX — capped at 50, imported into the DB so results open like cached mail. Reaches mail outside the sync window. POP3: none.

---

## 10. Autoconfig & manual accounts (`mail-autoconfig.ts`, `manual-account.ts`) — clean port

- **Autoconfig order:** (1) Mozilla/Thunderbird autoconfig over HTTPS — `autoconfig.thunderbird.net/v1.1/<domain>`, then `<domain>/.well-known/autoconfig/...`, then `autoconfig.<domain>/...`; (2) static preset table (gmail/googlemail, outlook/hotmail/live→office365, yahoo, icloud/me, fastmail → IMAP 993/ssl + SMTP 587/starttls); (3) generic guess `imap.<domain>:993/ssl` + `smtp.<domain>:587/starttls`. Regex XML parsing, 8s timeout, **no DNS SRV / MX / Autodiscover**. → OkHttp + `XmlPullParser`; logic ports directly. (Optional parity improvement: add SRV lookup via `dnsjava`.)
- **Manual add:** validates with a **live round-trip before saving** — IMAP `connect→logout`, SMTP `verify()` (connect+auth, no send), POP3 `STAT`. → Jakarta Mail `Store.connect()` + `Transport.connect()` reproduce the pre-save check. Provider is `imap` or `pop3` by `incomingProtocol`.

---

## 11. What maps cleanly vs. what needs rethinking (summary)

### Maps cleanly (logic ports, language changes)
- **Data model / schema** → Room entities 1:1 (§2), minus historical migrations and the credential column.
- **Threading algorithm** (`thread-util.ts`) → verbatim Kotlin.
- **Sync window policy** (`sync-policy.ts`) → verbatim.
- **IMAP sync *strategy*** — initial/incremental/UIDVALIDITY/flag-reconcile/expunge logic (§4) → same algorithms on a JVM IMAP client (pending the spike).
- **AI feature logic + caching** (§7) → same, only the SDK call shape changes.
- **Autoconfig + manual validation** (§10) → same.
- **Search behaviour** (§9) → replicate LIKE query in Room.
- **UI structure** — three-pane → Compose adaptive layout; optimistic updates → Room Flow observation (arguably *simpler* on Android, removing manual optimistic-list plumbing).

### Needs rethinking (the real Android work)
1. **Background execution (Step 2 — the biggest difference).** Persistent IDLE socket + sub-minute `setInterval` polling are not viable in the Android background post-8.0. → Foreground service (persistent notification + battery-optimization exemption) while active/IDLE-enabled; WorkManager periodic poll (≥15 min) as fallback; **exposed as a per-account IDLE-vs-poll setting**. Mirrors AquaMail. FCM/webhook push is explicitly out of scope v1.
2. **OAuth redirect + client type (Step 3).** Loopback HTTP server → custom-scheme/App Link + Chrome Custom Tabs; Google confidential-client-with-secret → public client + PKCE (no secret); Microsoft cache-scraping → MSAL Android native cache. New Android client registrations + a DEVELOPERS.md Android addendum.
3. **Secret storage.** `safeStorage` → Android Keystore + `EncryptedSharedPreferences`; **remove the plaintext fallback**; keep the DB credential-free.
4. **IMAP library capabilities (Step 6.1 spike — do first).** Must confirm on a real Gmail account: **XOAUTH2** over IMAP+SMTP, **IDLE**, **CONDSTORE/CHANGEDSINCE** (for cheap flag reconcile), **SORT**, and per-part **BODYSTRUCTURE** fetch. A bad answer here reshapes §4 (fallback: polling-only + full flag scans for v1).
5. **Filesystem/IO model.** Synchronous `fs` + raw paths → coroutines + scoped storage; inbound attachments as content URIs (SAF); outbound sharing via `FileProvider`.
6. **Native-shell affordances.** `Notification`/badge → `NotificationManager`; `mailto` protocol registration → `intent-filter`; `shell.openExternal`/print → `Intent`/`PrintManager`; `User-Agent`/`X-Mailer` string (`Orbit Mail 0.1.0 (Linux x64; Electron …)`) → rebuilt from `BuildConfig`/`Build` (e.g. `Orbit Mail <ver> (Android <api>)`).
7. **IPC event channels** (`onStatusChange`, `onMessagesUpdated`, `compose:open`, `app:needsAccount`) → `StateFlow`/`SharedFlow`; no serialization boundary.

---

## 12. Known issues observed during audit (carry into the port)
- **`markFolderAllRead` server call** uses `messageFlagsAdd({ seen: false }, ['\\Seen'], ...)` — the `{ seen: false }` search selector looks wrong for an "add `\Seen` to all" intent. Verify/fix when porting `folder-actions.ts` rather than replicating the bug.
- **Plaintext credential fallback** when encryption is unavailable (§6) — must not be reproduced on Android.
- **FTS index is built but unused by the query path** (§9) — decide deliberately in the port rather than carrying dead index-maintenance.

---

## 13. Explicitly out of scope for v1 (confirmed against the plan)
- **POP3** (`pop3-sync.ts` + POP3 branches in smtp/attachment/manual services) — synthetic-UID hashing, inbox-only, no move/copy. Excluded.
- **FCM/webhook push** — would reintroduce a server component.
- **Any server-side component** — the entire rationale for native over PWA.
- Windows/macOS/desktop packaging concerns, mbox export semantics beyond parity, auto-update/code-signing.

---

## 14. Recommended build order (unchanged from plan, validated by this audit)
1. **IMAP library spike** (§4, §11.4) — XOAUTH2 + IDLE + CONDSTORE + BODYSTRUCTURE fetch against real Gmail. **Do first.**
2. Room schema + DAOs from §2 (final schema, no historical migrations).
3. OAuth client registration (Google Android + Microsoft native) + AppAuth/MSAL (§5) + DEVELOPERS.md Android addendum.
4. Headless sync engine (§4) — prove against a real account before UI.
5. Compose UI: inbox list → thread reader → compose/send → search.
6. Foreground service + WorkManager + per-account IDLE/poll setting (§11.1).
7. AI features (§7).
8. Local notifications from sync results (§11.6) — no FCM.
