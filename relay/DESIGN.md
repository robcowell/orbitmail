# Orbit Mail Relay — Design (Step 1)

The relay is the server half of the Android PWA fork. It exists because a browser
cannot open IMAP/SMTP/POP3 sockets. It sits between the PWA and the mail
providers, reusing the protocol logic already written for the Electron app
(`electron/services/`), and exposes an HTTP + WebSocket API shaped like the relay
subset of `OrbitMailAPI` (`shared/types.ts`).

This document reflects the three architecture decisions resolved 2026-07-15
(see `android-audit.md` §9).

## Decisions baked in

1. **Host-agnostic.** No hardcoded host, port, external URL, TLS, or data path.
   All of it comes from env/config (`src/config.ts`). Deployment packaging is a
   later concern. The PWA is *told* its relay URL (user-entered at pairing), not
   auto-discovered.

2. **Web Push is in v1.** The relay holds VAPID keys and a durable push
   subscription store, and sends a Web Push when IMAP IDLE reports new mail.
   Foreground updates ride the WebSocket; background notifications ride Web Push.

3. **PWA holds long-lived secrets; relay is near-stateless for mail.** The client
   stores OAuth refresh tokens and the Anthropic key on-device (Web Crypto behind
   a PIN/passkey). Per session the client hands the relay a *currently valid
   access token* (and the manual IMAP/SMTP password for password accounts). The
   relay keeps credentials only in memory, only for the life of the connection.
   The single piece of durable server state is the push-subscription table — it
   contains no mail secrets.

## Shape

```
[Android Chrome PWA]
      │  HTTPS (request/response)  ── account ops, message ops, send, search, AI-attachment fetch
      │  WebSocket (server push)   ── sync status, "messages updated", new-mail events
      ▼
[Relay service]  ── holds creds in-memory per connection; durable state = push subs only
      │  IMAP / SMTP / POP3 / OAuth token refresh
      ▼
[Gmail / Microsoft 365 / generic IMAP]
```

## Credential handoff (decision 3 in practice)

Because the relay persists no refresh tokens, each authenticated call carries the
credential the relay needs to act:

- **OAuth accounts (Gmail/M365):** the PWA refreshes the access token client-side
  (a plain HTTPS token-endpoint POST — works in a browser) and sends the relay a
  short-lived bearer access token per request/connection. If the token is expired
  when the relay tries to use it, the relay returns a typed `token_expired` error
  and the PWA refreshes + retries. The relay never sees the refresh token.
- **Password accounts (manual IMAP/POP3):** the PWA sends username + password over
  the (TLS-terminated) relay connection; the relay uses them transiently and does
  not store them.
- **Relay session token:** an opaque token issued at pairing, sent on every call
  to authenticate the *client to the relay* (distinct from mail credentials).
  Stored client-side in IndexedDB.

## API surface (relay subset of `OrbitMailAPI`)

Derived from `android-audit.md` §2 "Relay-side" bucket. HTTP for
request/response, WS for server-initiated push.

**HTTP**
- `POST /accounts/oauth/exchange` — complete an OAuth code→token exchange help step (optional; the PWA can do this itself)
- `POST /accounts/manual/validate` — validate manual IMAP/SMTP/POP3 settings (`manual-account.ts`)
- `POST /accounts/autodetect` — autodiscover server settings (`mail-autoconfig.ts`)
- `POST /sync/refresh` — run a sync pass for an account, stream progress over WS
- `GET  /sync/status` — current sync status
- `POST /messages/mutate` — read/star/flag/delete/move/copy (server-side IMAP flag/location changes)
- `POST /messages/fetchBody` — fetch a message body on demand
- `POST /attachments/fetch` — fetch attachment bytes on demand (`attachment-fetch.ts`)
- `POST /compose/send` — send via SMTP (`smtp-send.ts`)
- `POST /search/server` — live IMAP SEARCH fallback
- `POST /folders/mutate` — create/emptyTrash/emptyJunk/markAllRead/export
- `POST /push/subscribe` / `POST /push/unsubscribe` — Web Push subscription lifecycle (decision 2)
- `GET  /health` — liveness

**WebSocket** (server → client)
- `sync:status` — mirrors `SyncStatus`
- `sync:messagesUpdated` — cache-invalidation ping
- `mail:new` — new-mail event from IDLE (also triggers a Web Push if the client is backgrounded)

The **local-only** IPC handlers from the audit (list/count/thread/get, prefs,
task read) do **not** live here — they run against the on-device OPFS/SQLite
cache in the PWA (Step 3). The relay is only the parts that need a mail-server
round-trip.

## Reuse map (what moves here from `electron/services/`)

Per `android-audit.md` §4, ~10 of 12 service modules lift over largely intact.
Two kinds of change are required:

- **Drop the Electron host bits:** `smtp-send.ts` imports `electron.app` only for
  a User-Agent version string → read from `package.json`/env instead.
  `oauth-loopback.ts` (the `http.createServer` loopback dance) is **replaced** by
  an HTTPS redirect/callback (`android-audit.md` §7), not ported.
- **Repoint storage sinks:** modules that write attachment bytes / read the DB via
  `fs` + `better-sqlite3` need their sink swapped. On the relay the mail cache is
  *not* the source of truth (the PWA's OPFS cache is); the relay streams
  bytes/headers back to the client rather than persisting them. Where the current
  code assumes a local SQLite (`db-service.ts` state like `highest_synced_uid`),
  the relay takes that sync-cursor state *from the request* (client sends its
  cursor) and returns the delta — keeping the relay stateless for mail.

`thread-util.ts` and `sync-policy.ts` are pure and reused verbatim. `shared/`
types are the wire contract.

> Consolidation note: rather than copy the pure modules, the clean end-state is to
> promote `thread-util.ts` / `sync-policy.ts` (and the domain types) into a
> package both the Electron app and the relay import. Deferred to avoid churning
> the Electron app mid-audit; tracked as a Step 1 follow-up.

## Storage (relay-side)

- **Push subscriptions** — the only durable table. `{ endpoint, keys, accountId,
  createdAt }`. Backing store is env-configured (SQLite file by default, path from
  config; swappable). No mail content, no secrets.
- **No message/attachment persistence.** The relay is a pass-through + sync
  coordinator (plan Step 1). The device cache is authoritative.

## Testing (flagged, per the plan's "defer but don't hide it")

- End-to-end proof — "sync one Gmail account via a CLI harness" (plan Step 5.1) —
  **requires Rob's OAuth web-client credentials and a live Gmail account**, which
  the build environment does not have. The harness (`src/harness.ts`) is built to
  run that proof locally once creds exist; it is **not** exercised in CI here.
- Pure logic (`thread-util`, `sync-policy`, autodetect parsing) is unit-testable
  with no network and is the sensible first test target.

## Status of this skeleton

- `src/config.ts`, `src/server.ts`, `src/harness.ts` establish the host-agnostic
  config, the HTTP/WS contract, and the harness entry point. Routes currently
  return `501 Not Implemented` with the correct shape — the contract is real, the
  protocol wiring is the next increment.
- Runs on Node built-ins only (no `npm install` needed to boot the health
  server), so the contract is inspectable immediately. The protocol deps
  (`imapflow`, `nodemailer`, `web-push`, …) are declared in `package.json` and
  wired as each route is implemented.
