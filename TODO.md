# Orbit Mail — Deferred Work

Items intentionally deferred. Tackle these before calling Orbit Mail production-ready for non-developers.

## Shipped since the initial pass

- **Delete to Trash** via `Delete` / `Backspace`, with provider-correct trash resolution (SPECIAL-USE `\Trash`), optimistic list removal, and a destination-named toast.
- **Unread-count badge** on the taskbar / launcher and in the window title.
- **Optional AI** (bring-your-own Anthropic key): per-message **Analyze** (summary, action items, questions, key context) and an inbox **Tasks** sweep (choice of **Unread** (default) or **All messages**). Sweep results and ticked-off tasks are persisted per folder; completed tasks are fed back to the model so they don't resurface. The task list can be exported to a Markdown file on demand.
- **Rich compose editor** — extended formatting toolbar (headings, bold/italic/underline/strikethrough, alignment, colour, lists, links, quote, inline code, clear), HTML send, collapsible quoted text on replies/forwards with an attribution line and separator, and a drag-and-drop attachment UI showing type icons and sizes.
- **Performance & perceived-speed pass (phases 1–3)** — tuned SQLite pragmas + `COUNT(*)` + summary-column projection + partial unread index + batched sync writes; optimistic read/star/flag/move/delete with rollback and an instant-painting reader; `virtua`-virtualized message list with memoized rows and reference-preserving refresh; folder-switch skeletons; a pooled per-account IMAP client with a per-account op mutex; parallel account sync; cached Sent path; send does a Sent-only sync; attachments fetch just their BODYSTRUCTURE part.
- **Bring-your-own-credentials** setup documented (README → "Run your own copy"; DEVELOPERS.md → OAuth setup + verification/CASA notes).

## Critical

### End-user OAuth distribution
- Google/Microsoft client IDs still require a developer `.env` at build/dev time.
- **Impact:** `.deb` / AppImage users cannot sign in without cloning and configuring their own credentials. The bring-your-own path is now documented (README → Run your own copy), but there is still no zero-config option.
- **Fix:** Ship registered public OAuth app IDs (needs verification + CASA for the restricted Gmail scope — see DEVELOPERS.md), or add an in-app settings screen for OAuth client configuration.

## AI follow-ups

- Thread / conversation-level analysis (currently single-message and folder-level sweep only).
- Reply-draft suggestions from a message.
- Model / effort / provider selection in AI settings (currently hardcoded to Claude Opus 4.8, Anthropic-only).
- Message-count / cost preview before an inbox sweep. (Sweeps are now **incremental**: each message's extracted tasks are cached on its row, so a Sweep only sends messages it has never analyzed — a re-sweep of an unchanged inbox spends zero tokens. Reopening the Tasks dialog reads persisted results with no call. A one-time full pass over new mail is still billed.)
- Optional **force re-analysis** for the sweep — the per-message cache assumes a message's tasks never change (true for immutable IMAP bodies), so there is currently no way to re-run the model on already-analysed mail (e.g. after tuning the prompt). `sweepTasks` is one boolean away from supporting it.

## Performance backlog (phase 4 — deferred)

- Move sync + `better-sqlite3` + `simpleParser` off the main process (utility process / worker thread) — the largest jank/memory win, and the riskiest change.
- Startup reorder: create and show the window before schema migration + mailto config.
- Bundle slimming: Phosphor deep per-icon imports, `manualChunks`, V8 code cache.
- Lighten the 20s poll for IDLE-capable accounts (STATUS-only / reduced cadence) since IDLE already push-syncs their inboxes.
- Hoist repeated raw prepared statements to module scope in `db-service.ts`.

## Post-MVP (logged for later)

- Local draft autosave + IMAP draft upload
- Conversation/thread view
- Compose signatures and inline/pasted images (rich HTML editor now shipped)
- Editable / trimmable quoted text (currently the collapsed quote is read-only and always included on send)
- Reply-all
- Attachment save-as (download path picker)
- Search operators (`from:`, `subject:`) and result highlighting
- Auto-update, code signing, CI, integration tests
- Cross-platform builds (Windows/macOS)
- POP3 move support or reduced POP3 scope
