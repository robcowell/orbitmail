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
- **Delete advances the selection** — deleting the selected message or conversation moves to the next row down (the row above when it was the last one), matching Apple Mail/Outlook/Thunderbird, instead of emptying the reader. Archive and move still clear the selection — deliberately left for now, as they are not the repeat-fire case.
- **Sent rows name the recipient** — in any account's Sent folder the list row shows who the mail went to instead of the sender (always the account owner), in threaded, flat, expanded-thread-child and search views; multiple recipients read as `A, B, +N`, deduped per address so one person written two ways is listed once.
- **Reply All** — replies to the sender plus all other To/Cc recipients (self and the original sender de-duplicated), exposed as a visible button in the single-message and thread reader headers and the toolbar, alongside the existing right-click context-menu entry.

## Decided: bring-your-own OAuth credentials

Orbit Mail does **not** ship Google/Microsoft OAuth credentials, and will not.
Shipping them means either embedding the builder's own client secret in every
package — prohibited, see CLAUDE.md rule 5 — or registering a public client and
taking it through Google verification plus a CASA security assessment for the
restricted Gmail scope. **That cost has been declined** (2026-07-21), so the
bring-your-own model is the design, not a stopgap.

What that means for someone installing a build:

- They register their own OAuth app once (DEVELOPERS.md → OAuth setup), then
  either enter the credentials in the Add Account dialog (#46), put them in
  `~/.config/orbit-mail/.env`, or export them in the environment.
- They click through Google's "unverified app" warning per account, and the
  unverified user cap (100) applies to their own app — which is ample for a
  personal client.

The engineering side of this is finished: a packaged build is self-sufficient
and needs no file editing (#45, #46). What remains is inherent to the model,
not a defect.

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
- ~~**POP3 has no socket timeout, and one stall wedges all sync.**~~ **Fixed** (#61) — `pop3ClientOptions` now sets a 60s socket timeout, which node-pop3 requires to arm its inactivity timer. A stalled connection (accepts TCP but never greets, or stalls mid-`RETR`) now rejects instead of hanging forever, so the per-account try/catch in `pollForNewMessages` recovers and `syncStatus.syncing` is cleared rather than stuck true. Guarded end-to-end by a suite check: a silent TCP server rejects in ~800ms instead of hanging.
- ~~**FTS index deletes are a permanent no-op.**~~ **Fixed by removal** (#36) — `messages_fts` was contentless, so `DELETE ... WHERE message_id = ?` could never match (a contentless FTS5 table reads every column back as NULL) and it accumulated a duplicate row per re-index. Nothing ever queried it: there was no `MATCH` anywhere in the codebase, and `searchMessages` has always used `LIKE`. It was dropped rather than repaired — indexing cost ~0.5ms per synced message and ~8MB for a write-only structure. Search behaviour is unchanged (verified: identical result hashes before and after).
  - **If full-text search is wanted later**, rebuild it as an *external-content* FTS5 table over `messages` (`content='messages'`, joined on the implicit `rowid`), maintained by triggers. That stores no duplicate text and makes deletes work. Note it would change matching semantics: FTS matches whole tokens, so searching `mail` would stop matching `gmail`, which today's substring `LIKE` does. Preserving that needs prefix or trigram tokenisation.
  - This also leaves the separate finding below (search full-scans `body_html` with `LIKE`) unaddressed — measured at 60ms on a 3.3k-message profile.
- ~~**`listThreads`/`countThreads` scan the whole account per render.**~~ **Partly fixed** (#35) — two expression indexes on `COALESCE(thread_id, id)` cut `listThreads` 57.7ms → 35.4ms and `countThreads` 3.9ms → 1.0ms on a real 3.3k-message profile (cold-cache raw query 119ms → 39ms), for ~0.9MB of index. Query rewrites were measured and rejected: a materialized CTE was a wash and a CTE join was worse.
  - **Still linear in account size.** The remaining ~35ms is computing `MAX(date)` per thread across the account and sorting every thread before `LIMIT/OFFSET` — the indexes make that cheaper, not sub-linear, so a 100k-message account will still be slow. Fixing it properly means denormalising the thread key and last-activity date (a `thread_key` column, or a per-thread aggregate table maintained on upsert/delete), which trades drift risk for an index-ordered page query.
  - `countThreads` is now effectively free, so only the list query is worth further work.

### Medium

- ~~**OAuth flows need PKCE and `state` validation.**~~ **Fixed** (#37) — both flows now send a PKCE challenge (S256) and a per-attempt random `state`, which the loopback listener checks before accepting a code. A mismatched callback is answered and ignored rather than treated as an error, so a hostile page cannot abort a real sign-in by racing it. The listener also has a 5-minute timeout and closes on every path, including an abandoned or failed attempt. Covered by the integration suite.
- ~~**Credential storage falls back to base64** with no warning~~ **Fixed** (#62) — the fallback is intentional (the app must still work without a keyring), but it was silent. It is now surfaced: the main process logs a warning at startup when `safeStorage` is unavailable, and a dismissible banner tells the user that saved passwords, tokens and API keys are obfuscated rather than encrypted, and to install a keyring. Exposed via `app.getSecureStorageStatus()`.
- ~~**`attachments:open` hands the file straight to the OS opener**~~ **Fixed** (#42) — opening an attachment whose extension can execute (`.desktop`, `.sh`, `.run`, `.jar`, `.exe`, and the rest) now shows a warning naming the real extension, defaulting to Cancel. A `.pdf.exe` reads as a PDF in the list; the prompt says otherwise.
- ~~**`shell:openExternal` does not validate the scheme.**~~ **Fixed** (#64) — a shared `isSafeExternalUrl` helper restricts the OS opener to `http`/`https`/`mailto`, applied to the `shell:openExternal` IPC handler *and* both `setWindowOpenHandler`s (which fire on `window.open`/`target=_blank` from message content — the same untrusted sink). Anything else is dropped rather than launched, so a `file:` or custom-scheme link in email HTML can no longer invoke an arbitrary handler. The `will-navigate` guard was already stricter (http/https only).
- ~~**STARTTLS autoconfig misparsed as implicit SSL.**~~ **Fixed** (#65) — `parseSecurity` tested `includes('tls')` before the `starttls` branch, and `'starttls'.includes('tls')` is true, so an autodetected STARTTLS `socketType` was stored as `ssl` and hung on a TLS handshake against its plaintext port (143/587). The type string is now authoritative and STARTTLS is checked before SSL/TLS, with a well-known-port fallback only when no `socketType` is given. `parseAutoconfigXml` is exported and the suite pins the classification (STARTTLS→starttls, SSL→ssl, port fallback).
- ~~**No index on `attachments.message_id`**~~ **Fixed** (#66) — `attachments_message_id_idx` added to `initTables` (fresh DBs), `migrateSchema` (existing DBs) and the Drizzle `schema.ts`. Every attachment read is by `message_id` and the `ON DELETE CASCADE` walks the same key, so the open path and the delete cascade no longer full-scan. The suite asserts the planner actually uses it (`EXPLAIN QUERY PLAN`), not just that it exists.
- ~~**`migrateFtsIndex` loads every body into one array.**~~ **Moot** — the FTS index and its migration were removed entirely (#36); `migrateFtsIndex` no longer exists. The startup-OOM path it described is gone with it.
- ~~**Unbounded attachment buffering during sync**~~ **Fixed** (#67) — the batch `pending` array held each message's parsed attachment `Buffer`s until the whole folder's fetch was written (~2GB for a folder of large attachments), though only filename/type/size are ever stored. Each attachment is now reduced to metadata (`toAttachmentMeta`) as soon as the message is parsed, so the Buffer is freed per-message instead of retained across the batch. Content is re-fetched on open, as before. The suite pins the reduction's field/size-fallback semantics.
- ~~**Packaged builds can't do OAuth.**~~ **Fixed** (#45, #46) — credentials resolve at runtime: environment, then `~/.config/orbit-mail/.env`, then values entered in the app when adding an account (stored encrypted via safeStorage). Deliberately never baked into the build — that would ship the builder's own client secret in every package (CLAUDE.md rule 5, enforced by tests).
- ~~**Unguarded DDL in `migrateSchema`**~~ **Fixed** (#68) — the `UNIQUE` index on `(folder_id, uid)` postdates the MVP, and a pre-existing duplicate made `CREATE UNIQUE INDEX` throw out of startup, every launch, with no in-app recovery. `dedupeMessagesByFolderUid` now runs first: duplicates are the same server message copied by the pre-constraint upsert, so it collapses each `(folder_id, uid)` to one row, keeping the row that carries the most work (AI analysis / sweep cache, then newest). It is a no-op on a healthy DB. The suite reproduces the duplicate, confirms it blocks the index, and checks dedupe fixes it and preserves the AI-carrying row.
- **POP3 UID is a 32-bit hash** (`pop3-sync.ts:41-48`, duplicated in `attachment-fetch.ts:191`) — ~1% collision chance at 10k messages. A collision silently skips a new message, or makes `DELE` delete the *wrong* message from the server.
- **Out-of-window POP3 messages re-download forever** (`pop3-sync.ts:91-101`) — the UID-skip check runs before the window check and windowed-out messages are never stored, so up to 200 full `RETR`+parse cycles run every 20s.
- **mbox export is lossy** (`folder-actions.ts:120-137`) — no `>From ` quoting (silently splits messages in every reader), whole folder materialized twice in memory, `toString('utf8')` corrupts 8-bit content.
- ~~**DB never reclaims space**~~ **Fixed** (#58) — `reclaimFreelistIfLarge` runs `VACUUM` on quit (after the window closes, so the ~2s block is invisible) when the freelist is both ≥25% of the file and ≥20MB. Self-throttling — VACUUM zeroes the freelist, so it does not run again until enough mail has been deleted to rebuild it — and skipped on small databases, where a full rewrite is not worth the churn. Measured: 315MB → 198MB on a real profile (116MB reclaimed).
- ~~**Local search full-scans the account with `LIKE` over `body_html`**~~ **Fixed** (#60) — search now scans a stored plain-text `search_text` column (text/plain, or stripped HTML) instead of the raw ~87MB of `body_html`: measured 99ms → 19ms on a real profile, and matches content not markup (a query for `div` no longer hits every `<div>`). Populated on upsert and backfilled in the background (chunked, so no startup freeze); search falls back to `body_html` for rows not yet reached, so it is correct throughout. The renderer-supplied `limit` is also clamped (≤200). **Still linear** in body size — `LIKE` cannot be indexed; a trigram FTS5 index over `search_text` would be the sub-linear next step, not taken here to avoid re-adding FTS machinery without separate justification.
- **On-disk permissions are left at defaults.** Raw `.eml` exports are written to `/tmp` and never cleaned up (`imap-sync.ts:1372`); the DB file is 0644 and the data/attachments dirs 0775, relying on Electron having created `~/.config/orbit-mail` as 0700. Set explicit modes (`0o700` dirs, `0o600` DB incl. `-wal`/`-shm`) and clean up temp exports.
- ~~**Remote content loads unconditionally**~~ **Fixed** (#63) — remote images and CSS backgrounds (`img src`, `srcset`, `background`, `poster`, `style` `url()`) are blocked by default. `sanitizeEmailHtml(html, { blockRemoteContent })` strips them via the existing `afterSanitizeAttributes` hook (inline `data:`/`cid:` kept); `hasRemoteContent()` gates a reader bar offering **Load images** (this message) or **Always load from sender** (persisted per-sender in `imageAllowedSenders`). No global "load everything" toggle yet — no general settings dialog exists to host it; the per-sender allow is the escape hatch.
- **AI prompt handling trusts message content** — bodies are interpolated straight into the prompt with no fencing or distrust framing (`ai-service.ts:287-296`, `:437-439`), and drafts derived from them are offered to the user to send. `isFromUser` also matches with `fromLower.includes(email)`, so a display name can flip the analysis polarity.

### Low

- ~~**Deleting an account left its AI Tasks behind.**~~ **Fixed** (#56) — `sweep_tasks` has no foreign key, so the account cascade did not reach it: removing an account deleted its mail, folders and attachment files but orphaned the AI Task rows (task text, source subject, sender, source message-id — content derived from the deleted mail). `removeAccount` now deletes the account's per-folder tasks and any unified-inbox tasks tied to its messages, before the cascade drops the folders/messages the subqueries need; other accounts' unified tasks are left alone. A guarded one-time migration (#57) also clears orphans left by deletions that predate the fix — scoped to per-folder tasks whose folder is gone (the unambiguous account-deletion signature), never unified tasks whose source message merely aged out of the cache. Surfaced by a user question about account-deletion hygiene; verified against a copy of a real DB and guarded by suite checks.
- ~~**Linux launcher badge never cleared.**~~ **Fixed** (#41) — the Unity `LauncherEntry` signal was emitted on a percent-encoded object path that D-Bus rejects outright, and the failure was swallowed as "this desktop ignores Unity signals", so a badge once set could never be cleared. `app.setDesktopName` was also stripping the `.desktop` suffix Electron documents as required, leaving `setBadgeCount` pointing at a non-existent entry. In-app counts were always correct; only the launcher was stale.


- Optimistic star/read/flag never rolls back in threaded view (the default), because `patchMessageInList` returns `null` when the row exists only in `selectedMessage` (`mailStore.ts:287-320`).
- `selectThread` has no error handling — a failed fetch pins "Loading conversation…" forever and rejects into a `void` call (`mailStore.ts:535-563`); milder in `selectMessage:1165`.
- Thread mutations (`deleteThread`, `archiveThread`, `moveThreadToFolder`) test a pre-`await` state snapshot, so the reader can keep showing a deleted conversation.
- ~~Compose sends the original message's **unsanitized** HTML in the quote block~~ **Fixed** (#69) — `src/components/compose/ComposeWindow.tsx` now runs the quoted original through `sanitizeEmailHtml(..., { blockRemoteContent: true })` when it is set, so both the compose preview and the sent body share one safe copy: the sender's scripts/navigation sinks are stripped, and their remote trackers no longer ride into the reply or the Sent folder (matching how #63 renders remote content).
- Bulk delete/prune paths are non-transactional and re-count folder unread per row; attachment files are unlinked before their DB rows.
- ~~Attachments sharing a filename overwrite each other on disk.~~ **Fixed** (#42) — the cache path is keyed by attachment id, and files are written 0600. The audit only spotted the on-disk half: an end-to-end test then showed *both* rows also resolved to the same MIME part, so the second attachment's content was never fetched at all. Attachments are identified by `(filename, size)`, but BODYSTRUCTURE reports encoded octets while the stored size is mailparser's decoded length, so the size rarely matches and both fell back to "first part with this name". Now disambiguated by position, which is how the rows are created.
- Accounts dedupe by email alone (`db-service.ts:38-41`), so adding a manual account overwrites an existing OAuth one in place.
- Renderer-supplied `attachmentPaths` are `readFileSync`'d with no allowlist (`smtp-send.ts:125-130`); the main process should track dialog-approved paths instead of trusting the renderer.
- ~~`buildLikePattern` leaves `_` as a live LIKE wildcard~~ **Fixed** (#70) — `\w` keeps the underscore, so a search for `foo_bar` also matched `fooXbar`. The pattern builder now backslash-escapes `\`, `_` and `%`, and every LIKE in `searchMessages` carries `ESCAPE '\'`, so a typed `_` matches a literal underscore. The suite asserts `foo_bar` hits the literal row but not `fooXbar`. (The former companion finding here, `SEARCH_FIELD_COLUMNS['constructor']`, was stale — that symbol no longer exists.)
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
