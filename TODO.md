# Orbit Mail — Deferred Work

Items intentionally deferred. Tackle these before calling Orbit Mail production-ready for non-developers.

## Shipped since the initial pass

- **Delete to Trash** via `Delete` / `Backspace`, with provider-correct trash resolution (SPECIAL-USE `\Trash`), optimistic list removal, and a destination-named toast.
- **Unread-count badge** on the taskbar / launcher and in the window title.
- **Optional AI** (bring-your-own Anthropic key): per-message **Analyze** (summary, action items, questions, key context) and an inbox **Tasks** sweep (choice of **Unread** (default) or **All messages**). Sweep results and ticked-off tasks are persisted per folder; completed tasks are fed back to the model so they don't resurface. The task list can be exported to a Markdown file on demand.
- **Rich compose editor** — extended formatting toolbar (headings, bold/italic/underline/strikethrough, alignment, colour, lists, links, quote, inline code, clear), HTML send, collapsible quoted text on replies/forwards with an attribution line and separator, and a drag-and-drop attachment UI showing type icons and sizes.
- **Conversation threading** — messages group by RFC 5322 headers (`thread_id` derived from `References`/`In-Reply-To`, subject fallback) into one collapsed row per conversation; opening a thread loads the full **account-wide** conversation across folders (Sent replies interleaved) in a stacked, collapsible reader. Includes AI **reply drafts** with tone options (Brief/Neutral/Detailed).
- **Performance & perceived-speed pass (phases 1–3)** — tuned SQLite pragmas + `COUNT(*)` + summary-column projection + partial unread index + batched sync writes; optimistic read/star/flag/move/delete with rollback and an instant-painting reader; `virtua`-virtualized message list with memoized rows and reference-preserving refresh; folder-switch skeletons; a pooled per-account IMAP client with a per-account op mutex; parallel account sync; cached Sent path; send does a Sent-only sync; attachments fetch just their BODYSTRUCTURE part.
- **Bring-your-own-credentials** setup documented (README → "Run your own copy"; DEVELOPERS.md → OAuth setup + verification/CASA notes).
- **Search upgrades** — scoped search (**All/From/To/Subject/Body**, persisted in `UiPreferences`) that now also matches sender/recipient (previously subject/snippet/body only); a one-click clear button; and a live **server-side (IMAP) fallback** that searches the whole mailbox when the local cache has no match (or on demand via *Search whole mailbox*), importing matches so they open like any cached message. POP3 has no server-side search.
- **Sync reconciliation** — server-side deletions (EXPUNGE) are reconciled into the local cache, and flag/expunge changes are pushed over IMAP IDLE.
- **AI attachments in Analyze** — per-message **Analyze** can optionally include a message's attachments for extra context (opt-in prompt, since it costs more tokens).
- **Quality-of-life fixes** — dark-mode attachment-chip contrast, search clear button, and an attachment paperclip on message-list rows.
- **Attachment save-as** — per-attachment **Save** and **Save all** actions, plus a right-click *Save attachment* context menu, with a download path picker.
- **Manual reply** — a primary, non-AI **Reply** action in the reader (opens the composer with quoted text); the AI reply-draft is demoted to a secondary action.
- **Reply All** — replies to the sender plus all other To/Cc recipients (self and the original sender de-duplicated), exposed as a visible button in the single-message and thread reader headers and the toolbar, alongside the existing right-click context-menu entry.

## Critical

### End-user OAuth distribution
- Google/Microsoft client IDs still require a developer `.env` at build/dev time.
- **Impact:** `.deb` / AppImage users cannot sign in without cloning and configuring their own credentials. The bring-your-own path is now documented (README → Run your own copy), but there is still no zero-config option.
- **Fix:** Ship registered public OAuth app IDs (needs verification + CASA for the restricted Gmail scope — see DEVELOPERS.md), or add an in-app settings screen for OAuth client configuration.

## Security & correctness audit (2026-07-21)

Full-codebase audit of the desktop app (Android port excluded). Findings are ranked by severity; file:line references were current at commit `0967177`. Everything below is **unfixed** unless marked.

> Security-relevant entries are stated as what to change and where, without reproduction detail, since this repo is public and these are open items.

**Fixed in #29 (renderer isolation):** untrusted email HTML could reach navigation sinks and `style`-based overlays that DOMPurify's defaults permit, and the `mailto:` body reached the compose editor's `innerHTML` unescaped. Three layers added: an expanded shared sanitizer (`src/utils/sanitizeEmailHtml.ts`), `will-navigate` blocking on both windows, and a renderer CSP.

**Fixed in #30 (IMAP sync):** the three High-severity sync defects — STARTTLS enforcement, the IDLE reconnect deadlock, and the UIDVALIDITY cache wipe. Struck through below.

Remaining items still reference the audit-time line numbers, which have shifted in `electron/services/imap-sync.ts`, `imap-idle.ts`, `smtp-send.ts` and `account-credentials.ts` since those two merges.

### High

- ~~**STARTTLS is not enforced on IMAP or SMTP-OAuth.**~~ **Fixed** (#30) — `imapConnectionSecurity()` replaces `imapFlowSecure()` and maps `'starttls'` to `{ secure: false, doSTARTTLS: true }`, making the upgrade mandatory; `createOAuthTransport` now sets `requireTLS: true`. Note the behaviour change: an account configured as STARTTLS against a server that does not offer it now fails to connect instead of silently continuing unencrypted.
- ~~**IDLE never reconnects — push mail dies silently.**~~ **Fixed** (#30) — the runtime entry is kept until the reconnect timer fires, so `scheduleIdleReconnect` can find it. Reconnects now actually happen, so they back off exponentially (5s → 5 min cap, reset on a successful connect).
- ~~**Sent mail never filed for manual IMAP accounts.**~~ **Fixed** (#32) — the MIME message is now built up front with `MailComposer` and that exact buffer is both submitted and appended to `Sent`, so the filed copy shares the delivered copy's Message-ID. The append is scoped to `provider === 'imap'`; Gmail files SMTP-submitted mail itself and would otherwise end up with two copies. Two loose ends it leaves behind:
  - **O365 Sent filing is unverified.** Exchange Online does not reliably file SMTP-submitted mail into Sent Items (it is governed by `MessageCopyForSMTPClientSubmissionEnabled`), so O365 accounts may have the same gap. It was left out of the fix rather than guessed at — needs testing against a real tenant.
  - **The filed copy does not record Bcc.** Bcc is deliberately kept out of the message headers (it belongs in the SMTP envelope), so the copy in `Sent` does not show who was blind-copied. Most clients keep Bcc in their Sent copy; matching that means a second build with `keepBcc` and a pinned Message-ID.
- ~~**UIDVALIDITY change destroys the local cache.**~~ **Fixed** (#30) — the restore set is resolved from the server rather than filtered against stale local UIDs (which silently dropped every colliding message), sized to what was cached and refilled in batches. `uidValidity` is only written after a successful refill, so an interrupted resync retries.
- **POP3 has no socket timeout, and one stall wedges all sync.** `pop3ClientOptions` never sets `timeout`, which node-pop3 requires to arm its socket timer. A stalled `RETR` leaves the promise pending forever with `syncStatus.syncing` stuck true, and every later poll and manual refresh short-circuits on `if (syncStatus.syncing) return`.
- ~~**FTS index deletes are a permanent no-op.**~~ **Fixed by removal** (#36) — `messages_fts` was contentless, so `DELETE ... WHERE message_id = ?` could never match (a contentless FTS5 table reads every column back as NULL) and it accumulated a duplicate row per re-index. Nothing ever queried it: there was no `MATCH` anywhere in the codebase, and `searchMessages` has always used `LIKE`. It was dropped rather than repaired — indexing cost ~0.5ms per synced message and ~8MB for a write-only structure. Search behaviour is unchanged (verified: identical result hashes before and after).
  - **If full-text search is wanted later**, rebuild it as an *external-content* FTS5 table over `messages` (`content='messages'`, joined on the implicit `rowid`), maintained by triggers. That stores no duplicate text and makes deletes work. Note it would change matching semantics: FTS matches whole tokens, so searching `mail` would stop matching `gmail`, which today's substring `LIKE` does. Preserving that needs prefix or trigram tokenisation.
  - This also leaves the separate finding below (search full-scans `body_html` with `LIKE`) unaddressed — measured at 60ms on a 3.3k-message profile.
- ~~**`listThreads`/`countThreads` scan the whole account per render.**~~ **Partly fixed** (#35) — two expression indexes on `COALESCE(thread_id, id)` cut `listThreads` 57.7ms → 35.4ms and `countThreads` 3.9ms → 1.0ms on a real 3.3k-message profile (cold-cache raw query 119ms → 39ms), for ~0.9MB of index. Query rewrites were measured and rejected: a materialized CTE was a wash and a CTE join was worse.
  - **Still linear in account size.** The remaining ~35ms is computing `MAX(date)` per thread across the account and sorting every thread before `LIMIT/OFFSET` — the indexes make that cheaper, not sub-linear, so a 100k-message account will still be slow. Fixing it properly means denormalising the thread key and last-activity date (a `thread_key` column, or a per-thread aggregate table maintained on upsert/delete), which trades drift risk for an index-ordered page query.
  - `countThreads` is now effectively free, so only the list query is worth further work.

### Medium

- ~~**OAuth flows need PKCE and `state` validation.**~~ **Fixed** (#37) — both flows now send a PKCE challenge (S256) and a per-attempt random `state`, which the loopback listener checks before accepting a code. A mismatched callback is answered and ignored rather than treated as an error, so a hostile page cannot abort a real sign-in by racing it. The listener also has a 5-minute timeout and closes on every path, including an abandoned or failed attempt. Covered by the integration suite.
- **Credential storage falls back to base64** when `safeStorage.isEncryptionAvailable()` is false (`account-credentials.ts:36`, `ai-service.ts:62`) — a normal state on Linux without a keyring. Surface it in the UI, or refuse to store.
- **`attachments:open` hands the file straight to the OS opener** (`main.ts:818`) with no type check or confirmation step. Warn on executable types before `shell.openPath`.
- **`shell:openExternal` does not validate the scheme** (`main.ts:806`). Restrict `new URL(url).protocol` to http/https/mailto in the main handler rather than trusting the renderer.
- **STARTTLS autoconfig misparsed as implicit SSL.** `mail-autoconfig.ts:38` tests `includes('tls')` first and `'starttls'.includes('tls')` is true, so the `starttls` branch is unreachable for the literal string. Autodetected 143/587 accounts get stored as `ssl` and hang on a TLS handshake against a plaintext port.
- **No index on `attachments.message_id`** (`db/index.ts:91-98`). Full scan on every email open, and with `ON DELETE CASCADE` on an unindexed child key, one full scan *per deleted parent row* — pruning 5,000 messages does 5,000 scans.
- **`migrateFtsIndex` loads every body into one array** (`search-index.ts:83-87`). `.all()` over `body_text`+`body_html` is ~320MB of JS strings at startup before any window exists; OOMs on large mailboxes, and the success flag is written afterwards so it crash-loops. Use `.iterate()`.
- **Unbounded attachment buffering during sync** (`imap-sync.ts:497,539-564`) — 200 parsed messages retain their attachment `Buffer`s until the batch write (~2GB for a folder averaging 10MB attachments). The buffers are never used: only filename/type/size are stored.
- **Packaged builds can't do OAuth.** `out/main/index.js` still contains a literal `process.env.GOOGLE_CLIENT_ID` — Vite doesn't inline arbitrary env vars into main, and `build.files` ships only `out/**` + `package.json`, so `dotenv/config` finds no `.env`. Sign-in should fail outright in a `.deb`/AppImage. Contradicts the "embedded at build time" claim in CLAUDE.md and DEVELOPERS.md; related to **End-user OAuth distribution** above but a separate, sharper bug.
- **Unguarded DDL in `migrateSchema`** (`db/index.ts:163`) — the `UNIQUE` index on `(folder_id, uid)` postdates the MVP, which had no such constraint; a pre-existing duplicate throws out of startup with no in-app recovery, on every launch.
- **POP3 UID is a 32-bit hash** (`pop3-sync.ts:41-48`, duplicated in `attachment-fetch.ts:191`) — ~1% collision chance at 10k messages. A collision silently skips a new message, or makes `DELE` delete the *wrong* message from the server.
- **Out-of-window POP3 messages re-download forever** (`pop3-sync.ts:91-101`) — the UID-skip check runs before the window check and windowed-out messages are never stored, so up to 200 full `RETR`+parse cycles run every 20s.
- **mbox export is lossy** (`folder-actions.ts:120-137`) — no `>From ` quoting (silently splits messages in every reader), whole folder materialized twice in memory, `toString('utf8')` corrupts 8-bit content.
- **DB never reclaims space** — `auto_vacuum=0` and no `VACUUM` anywhere; 148MB of a 331MB test DB was freelist.
- **Local search full-scans the account with `LIKE` over `body_html`** on the main process, with a renderer-supplied `limit` that is never clamped (`db-service.ts:1736-1759`).
- **On-disk permissions are left at defaults.** Raw `.eml` exports are written to `/tmp` and never cleaned up (`imap-sync.ts:1372`); the DB file is 0644 and the data/attachments dirs 0775, relying on Electron having created `~/.config/orbit-mail` as 0700. Set explicit modes (`0o700` dirs, `0o600` DB incl. `-wal`/`-shm`) and clean up temp exports.
- **Remote content loads unconditionally** — no block-remote-images preference anywhere, so opening an email confirms the read and reveals the client's IP to the sender (`img src`, `background`, `style="background:url(…)"`).
- **AI prompt handling trusts message content** — bodies are interpolated straight into the prompt with no fencing or distrust framing (`ai-service.ts:287-296`, `:437-439`), and drafts derived from them are offered to the user to send. `isFromUser` also matches with `fromLower.includes(email)`, so a display name can flip the analysis polarity.

### Low

- ~~**Linux launcher badge never cleared.**~~ **Fixed** (#41) — the Unity `LauncherEntry` signal was emitted on a percent-encoded object path that D-Bus rejects outright, and the failure was swallowed as "this desktop ignores Unity signals", so a badge once set could never be cleared. `app.setDesktopName` was also stripping the `.desktop` suffix Electron documents as required, leaving `setBadgeCount` pointing at a non-existent entry. In-app counts were always correct; only the launcher was stale.


- Optimistic star/read/flag never rolls back in threaded view (the default), because `patchMessageInList` returns `null` when the row exists only in `selectedMessage` (`mailStore.ts:287-320`).
- `selectThread` has no error handling — a failed fetch pins "Loading conversation…" forever and rejects into a `void` call (`mailStore.ts:535-563`); milder in `selectMessage:1165`.
- Thread mutations (`deleteThread`, `archiveThread`, `moveThreadToFolder`) test a pre-`await` state snapshot, so the reader can keep showing a deleted conversation.
- Compose sends the original message's **unsanitized** HTML in the quote block (`ComposeWindow.tsx:131-133`), carrying the sender's trackers into replies and the Sent folder.
- Bulk delete/prune paths are non-transactional and re-count folder unread per row; attachment files are unlinked before their DB rows.
- Attachments sharing a filename overwrite each other on disk (`attachment-fetch.ts:65` has no per-attachment discriminator).
- Accounts dedupe by email alone (`db-service.ts:38-41`), so adding a manual account overwrites an existing OAuth one in place.
- Renderer-supplied `attachmentPaths` are `readFileSync`'d with no allowlist (`smtp-send.ts:125-130`); the main process should track dialog-approved paths instead of trusting the renderer.
- `buildLikePattern` leaves `_` as a live LIKE wildcard (`search-index.ts:36-40`); `SEARCH_FIELD_COLUMNS[field]` resolves `'constructor'` via the prototype and throws (`db-service.ts:1746`).
- Pooled IMAP client replaced without closing the old socket when `usable === false` (`imap-pool.ts:95-98`). ~~Flag reconciliation holds the account's connection lane across every folder.~~ **Fixed** (#34) — `reconcileAccountFlags` now borrows the pooled client per folder, so an interactive op waits for one folder rather than the whole pass. Observed in a dev run as `[ipc-slow] messages:markRead 6288ms`; the integration suite reproduces it at 2995ms vs 312ms fixed.
- **Interactive IMAP ops still pay a cold reconnect.** `IDLE_CLOSE_MS` is 30s (`imap-pool.ts:16`), so a click after half a minute of inactivity waits for TCP + TLS + authentication, and an OAuth token refresh on Gmail. Raising it trades one longer-lived connection per account (Gmail allows 15; the app uses 2) for interactive latency. Measure before tuning.
- **`markRead`/`toggleStar` await the server round-trip inside the IPC handler** (`main.ts` `messages:markRead` et al). The renderer patches optimistically so the delay is not visible, but the handler stays open for the whole round-trip and a burst of actions serializes. Decoupling means a background queue plus a way to roll the UI back after the fact.
- The global `uncaughtException` handler logs and continues in an undefined state (`main.ts:114`); `void reconcileAllAccountsFlags(...)` at `imap-sync.ts:884` is the one `void` call site missing a `.catch()`.
- `folder-actions.ts:73` annotates a return type `Account` that is never imported (esbuild strips it, so `npm run build` passes).
- Preferences: every UI change rewrites the whole `app_state` blob including the sender lists (`preferences-service.ts:75-81`), and `getAppState()` returns the cached object by reference; `before-quit` flushes via a fire-and-forget `executeJavaScript`, so the last change can be lost.

### Checked and clean

No `rejectUnauthorized: false` anywhere. No SQL injection (every dynamic fragment is placeholder generation; no dynamic column/table names). No SMTP header injection (nodemailer strips CR/LF — verified directly). No attachment path traversal. No schema drift between `schema.ts`, `CREATE TABLE`, and `migrateSchema`. AI cache columns correctly survive sync upserts. The print path is sound: escaped interpolation, sanitized body, hidden window with `javascript: false`, `sandbox: true`, no preload. Renderer listener/interval cleanup is correct throughout.

## AI follow-ups

- Thread / conversation-level analysis (currently single-message and folder-level sweep only).
- ~~Reply-draft suggestions from a message.~~ **Shipped** — tone-steered (Brief/Neutral/Detailed) AI reply drafts grounded in the conversation, opened in the composer.
- Model / effort / provider selection in AI settings (currently hardcoded to Claude Opus 4.8, Anthropic-only).
- Message-count / cost preview before an inbox sweep. (Sweeps are now **incremental**: each message's extracted tasks are cached on its row, so a Sweep only sends messages it has never analyzed — a re-sweep of an unchanged inbox spends zero tokens. Reopening the Tasks dialog reads persisted results with no call. A one-time full pass over new mail is still billed.)
- Optional **force re-analysis** for the sweep — the per-message cache assumes a message's tasks never change (true for immutable IMAP bodies), so there is currently no way to re-run the model on already-analysed mail (e.g. after tuning the prompt). `sweepTasks` is one boolean away from supporting it.

## Performance backlog (phase 4)

**Shipped (quick wins):**
- Startup reorder — register IPC + show the window first, then defer background IMAP network (IDLE + polling) until after first paint, with an immediate catch-up sync on launch.
- Bundle slimming — deep per-icon Phosphor imports (ssr variants) and a vendor/react-vendor `manualChunks` split so app-code updates don't invalidate vendor chunks.
- IDLE-aware poll — POP3 polls every 20s; IDLE-capable IMAP accounts poll every 90s (IDLE push-syncs their inboxes).
- Hoisted the hot FTS index statements (run per message during sync) to module scope.

**Still deferred:**
- Move sync + `better-sqlite3` + `simpleParser` off the main process (utility process / worker thread) — the largest jank/memory win, and the riskiest change.
- V8 code cache for the renderer bundle (fragile to wire in Electron; the vendor split already helps cache reuse).
- Window bounds still live in the DB, so window creation opens the DB (migration is cheap post-first-run, so not decoupled).

## Post-MVP (logged for later)

- Local draft autosave + IMAP draft upload
- Thread-level context menu (archive/move whole conversation) and multi-thread select — currently threads support open, per-message actions, and whole-thread delete (Delete key)
- Compose signatures and inline/pasted images (rich HTML editor now shipped)
- Editable / trimmable quoted text (currently the collapsed quote is read-only and always included on send)
- Inline search-operator syntax (`from:`, `subject:`) and result highlighting — field **scoping** now ships via the search-scope selector (All/From/To/Subject/Body); inline operator parsing and match highlighting are still deferred
- Auto-update, code signing, CI, integration tests
- Cross-platform builds (Windows/macOS)
- POP3 move support or reduced POP3 scope
