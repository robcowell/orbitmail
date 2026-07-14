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
