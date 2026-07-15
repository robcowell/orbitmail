# Orbit Mail — Android (PWA) Audit

**Step 0 deliverable.** Introspection of the current Electron codebase before any
architecture work. Purpose: enumerate the full IPC surface, separate genuinely
platform-agnostic logic from Node-bound logic, and confirm the assumptions the
build plan rests on. Nothing here is built yet — this is the map that gates
Step 1.

Repo state at audit time: `v0.1.0`, branch `main` at `3431bc8`, Electron +
React/TS, Linux-only. Frontend is React 18 + Zustand; renderer talks to the
Electron main process exclusively through a single `contextBridge` API
(`window.orbitMail`, defined in `electron/preload.ts`).

---

## 1. The three hard walls (confirmed)

The plan's premise — that this is a fork requiring a client/server split, not a
build-target change — is confirmed. Grep results:

| Capability | Where | Browser equivalent |
|---|---|---|
| Raw IMAP/SMTP/POP3 sockets | `imapflow`, `nodemailer`, `node-pop3` across the sync/send services | **None.** Browsers cannot open TCP. Must move to a relay. |
| SQLite on disk (native module) | `better-sqlite3` in `electron/db/index.ts`; `drizzle-orm/better-sqlite3` | OPFS + WASM SQLite (`wa-sqlite`), see §5. |
| OS-keychain secret encryption | `safeStorage` in `account-credentials.ts` and `ai-service.ts` | **No equivalent.** Web Crypto + user PIN/WebAuthn, materially weaker — see §6. |

Additional Node-only touch points found:

- `net.connect` / `tls.connect` — **not used directly**; all socket work is
  inside `imapflow` / `nodemailer` / `node-pop3`. Good: no hand-rolled socket
  code to port, only library host-process changes.
- `app.getPath('userData')` — **single call site**, `electron/db/index.ts:14`.
  Storage paths are *not* hardcoded to `~/.config`; they derive from Electron's
  `userData`. This is the only path abstraction and it's cleanly isolated to the
  DB module. (Same finding as the Windows-portability discussion: the path layer
  is already centralized.)
- `http.createServer` — `oauth-loopback.ts` only, for the OAuth loopback dance.
  This is *replaced*, not ported (see §7).
- `https.request` — `mail-autoconfig.ts` (autodiscovery XML fetch). Node-bound
  but trivially portable / lives relay-side.

---

## 2. Full IPC surface (`ipcMain.handle`)

62 handlers registered in `electron/main.ts`, mirrored 1:1 by the preload API and
typed in `shared/types.ts` (`OrbitMailAPI`). Every one is a call the PWA must
re-implement as a fetch/WebSocket call to the relay **or** as a local
OPFS/IndexedDB operation. Grouped by where each must land:

### Relay-side (needs a mail server round-trip)
- `accounts:add` (OAuth), `accounts:addManual`, `accounts:autodetect`,
  `accounts:remove`
- `folders:create`, `folders:export`, `folders:emptyTrash`, `folders:emptyJunk`,
  `folders:markAllRead`
- `messages:markRead`, `toggleStar`, `setFlag`, `delete`, `deleteMany`, `move`,
  `copy` — all mutate IMAP server flags/location as well as the cache
- `sync:refresh`, `sync:getStatus`, `sync:onStatusChange` (push),
  `sync:onMessagesUpdated` (push)
- `search:server` (live IMAP SEARCH fallback)
- `compose:send`
- `attachments:download` / `open` / `saveAll` (fetch bytes from IMAP/POP3 on
  demand)

### Local-only (pure cache/DB/prefs — no server)
- `accounts:list`, `accounts:getInfo`, `accounts:updateDisplayName`,
  `accounts:updateSyncDays`
- `folders:list`
- `messages:list`, `count`, `listThreads`, `countThreads`, `getThread`, `get`
- `search:query` (local FTS5)
- `preferences:*` (get/saveUi/save/setHandleMailtoLinks/muteSender/blockSender)
- `ai:getTasks`, `completeTask`, `reopenTask`, `getStatus`

### Electron-desktop-only (no browser analogue — must be re-homed or dropped)
- `compose:open` / `close` / `onOpen` — a **separate `BrowserWindow`**. On
  Android this becomes an in-SPA route/modal (plan Step 2).
- `compose:pickAttachments` / `statAttachments` / `getPathForFile` — native file
  dialog + absolute paths. Replace with `<input type=file>` / drag-drop `File`
  objects; attachments become in-memory blobs, not paths.
- `attachments:saveAs`, `folders:export`, `ai:exportTasks` — native "save"
  dialogs → browser download (`showSaveFilePicker` unavailable on Android Chrome,
  so anchor-download fallback).
- `shell:openExternal` — `window.open`.
- `print:document` — offscreen `BrowserWindow` + OS print → `window.print()`.
- `app:onNeedsAccount` — internal event, trivially reproduced in-app.

### AI (Anthropic SDK — special case)
- `ai:analyze`, `ai:draftReply`, `ai:sweep` — these call the Anthropic API. The
  SDK runs in a browser, so the *call* ports directly. The blockers are (a) API
  key storage (§6) and (b) `ai:analyze`/`sweep` read attachment bytes off disk
  via `fs` in `ai-service.ts`, which must instead pull from OPFS or the relay.
- `ai:setApiKey` / `clearApiKey` / `getStatus` — key lifecycle, tied to §6.

---

## 3. What carries over untouched

**`shared/` is 100% reusable.** Both files are pure TS with zero Node imports:
- `shared/types.ts` — every domain type + the `OrbitMailAPI` contract. The API
  interface itself becomes the client-side service contract against the relay.
- `shared/folders.ts` — Gmail virtual-view detection, unread-count aggregation.
  Pure functions.

**Pure service logic (no Node runtime, only imports Node-typed neighbors):**
- `thread-util.ts` — `normalizeSubject`, `computeThreadId`, `normalizeReferences`.
  RFC 5322 threading. Pure; reuse verbatim on relay *and* client.
- `sync-policy.ts` — `isWithinSyncWindow` date logic. Pure.
- `search-index.ts` — FTS5 index SQL. Only a *type* import from `better-sqlite3`;
  the actual SQL (`CREATE VIRTUAL TABLE ... fts5`, insert/delete) is portable to
  `wa-sqlite`, which ships FTS5. Reuse the SQL, swap the driver handle.
- `preferences-service.ts` — prefs get/set logic; only needs the raw SQLite
  handle swapped.

**The Drizzle schema (`electron/db/schema.ts`) and query layer
(`db-service.ts`) are the second-highest-leverage reuse after the protocol
logic.** `db-service.ts` is ~all Drizzle queries (`eq`, `desc`, `and`, `inArray`,
`sql`…) plus `crypto.randomUUID` (available as `crypto.randomUUID()` in browsers)
and a little `fs` for attachment-file cleanup. If `wa-sqlite` can back a Drizzle
driver (or we run the same SQL through wa-sqlite directly), the entire read/query
surface — list/count/thread/get/search — moves to the client with minimal change.
This is what makes OPFS+WASM-SQLite (Step 5, Plan A) strongly preferable to an
IndexedDB rewrite: it preserves this whole layer.

---

## 4. The protocol logic — the reuse prize (relay-side)

This is the highest-leverage reuse in the project (plan Step 1/Step 5.1). It is
**already cleanly factored into standalone service modules** that import each
other and `shared/`, but *not* React and *not* Electron windowing — so lifting
them into a standalone Node service is mechanical, not a rewrite:

| Module | Role | Node deps | Relay-ready? |
|---|---|---|---|
| `imap-sync.ts` | Core IMAP sync, header/body fetch, sent-append | `imapflow`, `mailparser`, `fs`, `os` | Yes — swap `fs` writes for relay/stream |
| `imap-pool.ts` | Connection pooling | `imapflow` | Yes, as-is |
| `imap-idle.ts` | IMAP IDLE push → triggers resync | `imapflow` | Yes — becomes the push source (§8) |
| `smtp-send.ts` | Send via SMTP | `nodemailer`, `fs`, `electron.app` | Yes — drop the one `app` import (used for User-Agent version string) |
| `pop3-sync.ts` | POP3 sync | `node-pop3` | Yes, but **out of scope v1** (plan Step 6) |
| `manual-account.ts` | Manual IMAP/POP3/SMTP validation | `imapflow`, `nodemailer`, `node-pop3` | Yes |
| `mail-autoconfig.ts` | Autodiscover server settings | `https` | Yes |
| `oauth-google.ts` | Google OAuth + token refresh | `google-auth-library` | Yes — **but redirect flow changes**, §7 |
| `oauth-microsoft.ts` | MS OAuth + token refresh | `@azure/msal-node` | Yes — same caveat |
| `attachment-fetch.ts` | Lazy attachment byte fetch | `mailparser`, `node-pop3`, `imap-pool` | Yes |
| `account-credentials.ts` | Encrypt/decrypt token blobs, build client opts | `safeStorage` | **Split**: client-option builders relay-side; the `safeStorage` encrypt/decrypt is replaced (§6, and relay-held tokens per §7) |

Net: ~10 of 12 service modules move to the relay largely intact. The valuable
protocol/business logic doesn't change — only its host process and its storage
sink.

---

## 5. Storage — message cache & attachments

- **Cache:** current schema (`electron/db/schema.ts`) is 6 tables + an FTS5
  virtual table, WAL mode, several perf pragmas, and an in-code migration ladder
  (`migrateSchema`). Target: **OPFS + `wa-sqlite`** (WASM SQLite over OPFS),
  keeping schema and queries. OPFS is available on Android Chrome; the File System
  Access API is **not** — confirmed still the right call. Pragmas like
  `mmap_size`/`journal_mode=WAL` may not all apply under the WASM VFS; the
  migration ladder and FTS5 do carry over. **Plan B (IndexedDB rewrite) stays a
  fallback**, and it would strand the `db-service.ts`/`search-index.ts` reuse
  from §3.
- **Attachments:** today they're files under
  `userData/data/attachments/`, referenced by `attachments.local_path`. On
  Android: store blobs in OPFS under the same directory-per-account structure;
  `local_path` becomes an OPFS path/key. `attachment-fetch.ts`'s lazy-fetch model
  (metadata first, bytes on demand) maps directly — bytes come from the relay
  instead of a live IMAP socket the renderer can't open.

---

## 6. Secrets — the honest downgrade

Two secret stores today, **both `safeStorage`** (OS-keychain-backed AES):
1. `account-credentials.ts` — IMAP passwords + OAuth token blobs (`token_blob`
   column on `accounts`).
2. `ai-service.ts` — the Anthropic API key (in `app_preferences`).

`safeStorage.isEncryptionAvailable()` gates both, with a plaintext fallback.

**There is no browser equivalent.** Per plan Step 3: Web Crypto (AES-GCM) with a
key derived from a user-set PIN or WebAuthn/passkey unlock, ciphertext in
IndexedDB. **This is materially weaker** than an OS keychain — the key material
lives in the page's origin storage and is only as strong as the user's PIN/device
lock, with no hardware-backed key isolation. This must be stated plainly in the
design doc, not glossed.

**This is also the strongest argument for the relay holding refresh tokens
(§7):** if long-lived OAuth secrets never touch the device, the weaker client-side
store only ever protects a short-lived relay session token + (optionally) the
Anthropic key. That materially shrinks the blast radius of the downgrade.

---

## 7. OAuth — a second client registration is unavoidable

Confirmed from `.env.example` + `DEVELOPERS.md` + `oauth-loopback.ts`:

- Current flow is the **desktop loopback dance**: `http.createServer` on a random
  `127.0.0.1` port, redirect URI registered **exactly** as
  `http://127.0.0.1/callback` for both Google (Desktop-app credential) and
  Microsoft (public client, "Allow public client flows = Yes").
- Google **Desktop-app** credentials and the loopback redirect URI **will not
  accept an HTTPS web redirect.** The PWA needs an HTTPS redirect URI on the
  relay (or a static callback page) → **a new OAuth client registration** (Google
  "Web application" credential; a Microsoft SPA/web redirect). This is *not* a
  reuse of the existing `.env` `GOOGLE_CLIENT_ID` / `MICROSOFT_CLIENT_ID`.
- The browser redirect flow is actually *simpler* than the loopback dance, so the
  net change is registration + a relay callback route, not new protocol code.
- **Recommendation (matches plan):** relay holds refresh tokens; the PWA only
  ever holds a short-lived relay session token. Keeps §6's weakened client store
  off the critical secret path. `oauth-google.ts` / `oauth-microsoft.ts` token
  *refresh* logic moves relay-side largely intact; only the redirect/callback
  transport changes.

Scope flag for Step 0 → Step 4: the "bring-your-own-OAuth-credentials"
philosophy in DEVELOPERS.md survives, but the setup instructions must gain a
second (web) credential type. Budget doc changes there.

---

## 8. Push notifications — a real dependency, needs a scope decision

`imap-idle.ts` already implements IMAP IDLE and emits `sync:messagesUpdated` /
`sync:status` to the renderer. On desktop that's an in-process event. On Android:
- IDLE must live on the **relay** (only it holds the socket).
- Turning "new mail" into an OS notification when the PWA is closed requires **Web
  Push** (VAPID) — which requires a server component to hold push subscription
  endpoints and send pushes. The relay is the natural home.
- **Open question for Rob (plan Step 1):** is Web Push in scope for v1? If not,
  the relay still needs IDLE→WebSocket for *foreground* live updates, but can
  defer the Push subscription/VAPID machinery. This gates Step 5.6.

---

## 9. Gating decisions — RESOLVED

These three were genuine product/ops calls. Answered by Rob 2026-07-15:

1. **Relay deployment story → build host-agnostic, decide later.** The relay
   makes no assumptions about its host: everything host-specific (bind address,
   external URL, TLS, data dir) comes from env/config. Deployment packaging is
   deferred until the relay works. *Implication:* config abstraction up front, no
   hardcoded hosts/paths, and the PWA↔relay pairing must be configurable (user
   enters their relay URL), not discovered.

2. **Web Push → in scope for v1.** The relay owns VAPID keys and a push
   subscription store, and sends a Web Push on new mail detected via IMAP IDLE.
   Foreground live updates go over WebSocket; background notifications go over Web
   Push. *Implication:* Step 5.6 is in, not deferred — the relay is stateful for
   push subscriptions even though it stays near-stateless for mail.

3. **Secrets → PWA holds them, encrypted (overrides the plan's recommendation).**
   OAuth refresh tokens and the Anthropic API key live on-device, encrypted via
   Web Crypto behind a PIN/passkey (§6). The relay does **not** persist long-lived
   mail secrets. *Implication:* the client performs (or drives) OAuth token
   refresh and hands the relay a usable access token per session/request; the
   relay holds credentials only transiently in memory for the life of a
   connection. This keeps the relay simpler and portable (decision 1) but does
   expose long-lived secrets to the weaker on-device store — the §6 downgrade must
   be documented prominently in the user-facing security notes. The one piece of
   durable server state is the Web Push subscription table (decision 2), which
   holds no mail secrets.

See `relay/DESIGN.md` for how these fold into the Step 1 architecture.

---

## 10. Suggested build order (unchanged from plan, with audit notes)

1. **Relay** — lift `imap-*`, `smtp-send`, `oauth-*`, `manual-account`,
   `mail-autoconfig`, `attachment-fetch`, `thread-util`, `sync-policy` into a Node
   service behind an HTTP/WebSocket API shaped like `OrbitMailAPI`'s relay subset
   (§2). Prove one Gmail account syncs end-to-end via a CLI harness before any UI.
   *(Test infra: a CLI harness here is the pragmatic substitute for a full suite —
   flagged, not skipped silently.)*
2. **PWA shell** — manifest, service worker, install prompt, offline shell.
3. **Storage** — OPFS + `wa-sqlite`; port schema + migration ladder + FTS5;
   validate the Drizzle/`db-service.ts` reuse (§3, §5) before committing to it.
4. **Wire frontend to relay** — replace the 12 `window.orbitMail` call sites,
   feature by feature: Inbox list → read → compose/send → search → AI last.
   Audit CSS for hover-only affordances + tap-target sizing (plan Step 2).
5. **OAuth** — new web credential + relay callback (§7).
6. **Push** — only if §8/Q2 says v1.
7. **AI** — port `ai-service.ts` calls; resolve key storage (§6/Q3); repoint
   attachment reads from `fs` to OPFS/relay.

---

## Summary

- **Reuse is high and cleanly separated.** `shared/` (100%), the protocol
  services (~10/12 modules), the Drizzle schema + query layer, and the pure
  threading/search/policy helpers all carry over. The valuable code is the part
  that survives.
- **Three things genuinely have no browser equivalent** and drive the whole fork:
  sockets (→ relay), disk SQLite (→ OPFS/wa-sqlite), keychain (→ Web Crypto,
  weaker).
- **Two hard prerequisites** the plan already flags, now confirmed concrete:
  a second (web) OAuth client registration (§7), and a server component for any
  Web Push (§8).
- **Do not start Step 1 until Q1–Q3 (§9) are answered** — they're Rob's calls,
  and they change what gets built.
