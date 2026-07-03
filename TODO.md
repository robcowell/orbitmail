# Orbit Mail — Deferred Work

Items intentionally deferred. Tackle these before calling Orbit Mail production-ready for non-developers.

## Shipped since the initial pass

- **Delete to Trash** via `Delete` / `Backspace`, with provider-correct trash resolution (SPECIAL-USE `\Trash`), optimistic list removal, and a destination-named toast.
- **Unread-count badge** on the taskbar / launcher and in the window title.
- **Optional AI** (bring-your-own Anthropic key): per-message **Analyze** (summary, action items, questions, key context) and an unread-inbox **Tasks** sweep.
- **Bring-your-own-credentials** setup documented (README → "Run your own copy"; DEVELOPERS.md → OAuth setup + verification/CASA notes).

## Critical

### End-user OAuth distribution
- Google/Microsoft client IDs still require a developer `.env` at build/dev time.
- **Impact:** `.deb` / AppImage users cannot sign in without cloning and configuring their own credentials. The bring-your-own path is now documented (README → Run your own copy), but there is still no zero-config option.
- **Fix:** Ship registered public OAuth app IDs (needs verification + CASA for the restricted Gmail scope — see DEVELOPERS.md), or add an in-app settings screen for OAuth client configuration.

## AI follow-ups

- Thread / conversation-level analysis (currently single-message and unread-folder sweep only).
- Reply-draft suggestions from a message.
- Model / effort / provider selection in AI settings (currently hardcoded to Claude Opus 4.8, Anthropic-only).
- Message-count / cost preview before an inbox sweep; sweeps are not cached, so each run spends tokens.

## Post-MVP (logged for later)

- Local draft autosave + IMAP draft upload
- Conversation/thread view
- Rich HTML compose editor and signatures
- Reply-all
- Attachment save-as (download path picker)
- Search operators (`from:`, `subject:`) and result highlighting
- Auto-update, code signing, CI, integration tests
- Cross-platform builds (Windows/macOS)
- POP3 move support or reduced POP3 scope
