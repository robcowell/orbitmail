# Core Sync Engine (Plan Step 4)

Headless port of the desktop IMAP sync engine (audit §4) onto the spike's
verified Jakarta Mail, wired to the Step 2 data model via a `MailRepository`
port and the Step 3 OAuth token via XOAUTH2. **Proven end-to-end against a real
IMAP server (GreenMail) with a real SQLite store — nothing mocked.**

## What's here (all built + tested in this sandbox)

| File | Role |
|---|---|
| `Model.kt` | Domain types (Provider, FolderType, Auth, SyncAccount, ParsedMessage, …) mirroring the Step 2 wire values |
| `MailRepository.kt` | The persistence **port** — implemented by a Room adapter in the app, by SQLite in tests |
| `ThreadUtil` / `SyncWindow` / `FolderTyping` | Pure ports of `thread-util.ts` / `sync-policy.ts` / `detectFolderType` |
| `imap/ImapConnection` + `ImapConnectionFactory` | Jakarta Mail wrapper (LIST, STATUS, UID search/fetch, flags) + XOAUTH2/password connect |
| `imap/MimeParsing` | MimeMessage → ParsedMessage (headers, threading, body, attachments) |
| `SyncEngine` | `syncAccount` / `syncFolder` / `reconcileFolderFlags` |

## Verified end-to-end (`gradle test`, 11/11)

Engine driving GreenMail + a SQLite `MailRepository`:

| Proof | Confirms (audit §4) |
|---|---|
| `initialSync_…` | Folder discovery + typing (INBOX), initial batch fetch, unread count |
| `incrementalSync_fetchesOnlyNewUids` | UID-delta: a second sync fetches only new UIDs, not the whole folder |
| `syncWindow_dropsMessagesOlderThanWindow` | Per-account `syncDays` window drops out-of-window mail |
| `threading_groupsReplyWithRoot` | Reply + root collapse to one thread id (References root) |
| `flagReconcile_pullsServerSeenOntoLocalRow` | Full-scan reconcile pulls server `\Seen` onto local rows; unread recount |
| `expunge_removesLocallyDeletedMessage` | Server-side deletion detected and removed from the cache |
| `resync_isIdempotent_noDuplicates` | `UNIQUE(folder_id, uid)` + delta prevent duplicates |

Plus `UtilTest` for the pure ports (threading precedence, window cutoff, typing).

### Bug the real-server test caught
Fetching a message body with Jakarta Mail's `getContent()` marks it `\Seen` on
the server; the reconcile pass then pulled that back and zeroed the unread count.
Fixed with `mail.imap.peek=true` (BODY.PEEK) — the same non-marking fetch the
desktop's imapflow uses. A mock would not have surfaced this.

## How it wires to the other steps

- **Step 1 (spike):** uses the same `com.sun.mail.imap.*` API (→ `android-mail`
  on device); `ImapConnectionFactory` uses the proven XOAUTH2 config.
- **Step 2 (data):** `MailRepository` maps 1:1 onto FolderDao/MessageDao
  (`upsertFolder`, `uidSet`, `maxUid`, `insertNewMessages`=insertIgnore count,
  `applyFlagUpdates`, `deleteByUid`, `recalculateUnread`, `pruneOlderThan`). The
  app provides a thin Room-backed adapter.
- **Step 3 (auth):** `Auth.XOAuth2(email, accessToken)` takes the token from
  `AppAuthAuthenticator.freshAccessToken()`, refreshed before each connect.

## Deferred (documented, not blocking)

- **CONDSTORE `CHANGEDSINCE` fast-path** — the cheap flag-reconcile optimization.
  The API is compiled in the spike's `CapabilityReference`; GreenMail doesn't
  implement CONDSTORE, so the **full-scan fallback** (verified here) is the
  tested path. Layer the fast-path on when the server advertises CONDSTORE.
- **Room adapter** (`MailRepository` over the Step 2 DAOs) — trivial glue, built
  in the app module (Room isn't reachable in this sandbox).
- **IMAP IDLE integration** — the spike proved IDLE; wiring it into a foreground
  service is **Step 6**, not the core engine.
- **Live Gmail run** — XOAUTH2 handshake is the spike's Layer 3; the engine
  consumes the token identically.

## Run

```bash
cd android/sync/engine
gradle test      # 11 passed
```
