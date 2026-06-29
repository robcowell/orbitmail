# Orbit Mail — Deferred Work

Items intentionally deferred after the High Impact + Trust/Polish pass. Tackle these before calling Orbit Mail production-ready for non-developers.

## Critical

### End-user OAuth distribution
- Google/Microsoft client IDs still require a developer `.env` at build/dev time.
- **Impact:** `.deb` / AppImage users cannot sign in without cloning and configuring credentials.
- **Fix:** Ship registered public OAuth app IDs, or add an in-app settings screen for client configuration.

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
