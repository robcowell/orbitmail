# Orbit Mail — Android (native Kotlin port)

A self-contained native Android rewrite of the Electron desktop client (audit:
[`../android-native-audit.md`](../android-native-audit.md)). Built as a
multi-module Gradle project: the risk-bearing logic in each module is verified on
the JVM in this repo; the Android/Compose/Room/OAuth layers build on a dev
machine with the Android SDK + Google Maven.

## Module graph

`:app` composes seven deliverable modules. Arrows are Gradle dependencies.

```
:app  (com.android.application)
 ├── :data:room          Room entities + DAOs                 (Step 2)
 ├── :sync:engine        headless IMAP sync engine            (Step 4)  ── uses Jakarta Mail
 ├── :auth:core          OAuth logic (PKCE, scopes, tokens)   (Step 3)
 ├── :auth:appauth       AppAuth integration + Keystore port  (Step 3)  ── uses :auth:core
 ├── :ui:presentation    UI state/reducers/reply/format       (Step 5)
 ├── :ui:compose         Compose screens + ViewModels         (Step 5)  ── uses :ui:presentation
 ├── :background:policy  sync-schedule + notification policy  (Step 6)
 ├── :background:service FGS IDLE + WorkManager               (Step 6)  ── uses :background:policy, :sync:engine
 ├── :smtp:send          SMTP submission (XOAUTH2/password)   (SMTP)    ── uses Jakarta Mail
 └── :ai                 Anthropic client + features          (Step 7)
```

Not part of the app (standalone JVM verification harnesses, excluded from
`settings.gradle.kts`): `data-layer/schema-verify`, `imap-spike`.

## How the modules compose — the port adapters (in `:app`)

Each module depends on an *interface* it doesn't implement; `:app` supplies the
adapter. Writing these proved the module interfaces line up.

| Port (defined in) | Adapter (`:app`) | Backed by |
|---|---|---|
| `MailRepository` (`:sync:engine`) | `RoomMailRepository` | `:data:room` FolderDao/MessageDao |
| `MailUiRepository` (`:ui:compose`) | `RoomMailUiRepository` | `:data:room` (Flow reads) + `:sync:engine` (refresh) + `:smtp:send` (send) |
| `SecureCredentialStore` (`:auth:appauth`) | `KeystoreCredentialStore` | Android Keystore + EncryptedSharedPreferences |
| `ApiKeyStore` (`:ai`) | `KeystoreApiKeyStore` | same secure prefs |
| model-call lambda (`:ai` `AiService`) | `AppGraph.aiService` | `:ai` `AnthropicClient` + the API key |

`AppGraph` is the single composition root (manual DI); `OrbitApplication` owns it;
`MainActivity` builds the ViewModels over `mailUiRepository` and renders `OrbitApp`.

## Verified in this repo (JVM, `gradle test` per module)

Everything that could be tested without the Android SDK was — against real
infrastructure wherever reachable (a live IMAP server, a real SQLite engine, the
Anthropic API shape, RFC test vectors).

| Module | Suite | Result | What it proves |
|---|---|---|---|
| `imap-spike` | GreenMail + compile | **8 pass, 1 skip** | Jakarta Mail: IDLE push, partial BODY.PEEK fetch, SORT, XOAUTH2 format, CONDSTORE API |
| `data-layer/schema-verify` | sqlite-jdbc | **9 pass** | schema DDL, cascade, unique(folder,uid), partial-index recount, thread window-fn, unified inbox, scoped search |
| `auth/core` | JUnit | **9 pass** | PKCE vs RFC 7636, exact scopes, auth-URL, refresh skew, state, token parse |
| `sync/engine` | GreenMail + SQLite | **14 pass** | initial/incremental sync, window, threading, flag reconcile, expunge, idempotency; + write-path: \Seen/\Flagged, delete (expunge), move (copy+expunge) |
| `ui/presentation` | JUnit | **9 pass** | optimistic update + rollback, reply-all dedup, References chain, formatting, search |
| `background/policy` | JUnit | **8 pass** | IDLE/poll resolution, FGS decision, 15-min clamp, anchored poll, backoff, notification |
| `ai` | JUnit (+gated live) | **9 pass, 1 skip** | request shape, structured-output parse, refusal handling, incremental sweep (0-token) |
| `smtp:send` | GreenMail SMTP | **5 pass** | delivery, RFC 5322 threading + mailer headers, multipart/alternative, to/cc/bcc fan-out, raw-bytes return |

**71 passing JVM tests**, plus 2 gated (real-Gmail / real-Anthropic) handoffs.

## Build the app (dev machine)

Requires Android SDK (compileSdk 35), JDK 17, and Google Maven access.

```bash
cd android
# provide OAuth client ids (see auth/OAUTH_SETUP.md) via gradle properties or CI:
#   -PGOOGLE_CLIENT_ID=... -PMICROSOFT_CLIENT_ID=... -PAPPAUTH_REDIRECT_SCHEME=com.googleusercontent.apps.<id>
./gradlew :app:assembleDebug
```

Versions are centralized in `gradle/libs.versions.toml`. Note: when assembling,
the existing per-module build files use inline plugin versions (`kotlin("jvm")
version "2.1.20"`) so they build standalone in the sandbox; switching them to the
catalog aliases (`alias(libs.plugins.kotlin.jvm)`) is a mechanical step so every
module shares one Kotlin/AGP version. The per-module `settings.gradle.kts` files
are for standalone `gradle test` and are ignored by the root build.

## Remaining integration work (explicit TODOs)

The port is feature-complete in logic; these are the wiring tasks that need the
device/app context, each flagged in code:

- **SMTP send** — ✅ ported to `:smtp:send` (Jakarta Mail Transport, XOAUTH2 +
  password, MIME + RFC 5322 threading), wired through `AppGraph.sendMail` for
  OAuth (Gmail/O365) accounts. Still open: appending the sent message to the
  server Sent folder (`SmtpSender.send` already returns the raw bytes for it),
  and manual (IMAP/POP3) SMTP — blocked on Android manual-credential storage.
- **Server-side mutation propagation** — ✅ `:sync:engine` `ImapMutations`
  (`setSeen`/`setFlagged`/`delete`/`move`, GreenMail-verified) is wired through
  `RoomMailUiRepository` via a `ServerMutations` port that `AppGraph` implements
  (resolve message→uid + folder→IMAP path + account→`SyncAccount`, run on
  `Dispatchers.IO`). Each optimistic local write mirrors to IMAP best-effort;
  failures self-heal on the next sync (flag reconcile / re-import). Flag *colour*
  stays local-only (IMAP has just the boolean `\Flagged`, owned by the star), as
  on desktop. OAuth accounts only (manual creds not yet stored).
- **Refresh wiring** — ✅ `AppGraph.mailUiRepository.refresh` now builds a
  `SyncAccount` per stored account (provider IMAP endpoint + `Auth.XOAuth2(
  freshAccessToken(id))`) and runs `syncEngine.syncAccount` on `Dispatchers.IO`
  (`null` = all accounts). Still open: OAuth-only for now (manual IMAP/POP3 are
  skipped pending credential storage), and per-account error isolation so one
  failing account doesn't abort a full refresh.
- **SyncManager controllers** — ✅ `AndroidForegroundServiceController` (start/stop
  the IDLE FGS) and `WorkManagerScheduler` (unique periodic `SyncWorker`) implement
  `SyncManager`'s ports; `OrbitApplication` reconciles on startup and every app
  foreground/background transition (`ProcessLifecycleOwner`). The worker runs a
  real sync via a `BackgroundSyncHost` the app implements (keeps `:background:service`
  app-agnostic) and posts a new-mail notification. Default per-account mode is a
  15-minute poll (battery-friendly). Still open: the FGS **IDLE loop body** (real
  `folder.idle()` push — needs IDLE support in the connection layer), a sync-prefs
  UI to opt accounts into IDLE, a dedicated notification icon, and the
  `POST_NOTIFICATIONS` runtime request.
- **Thread participants** aggregation (`:data:room` deferred it).
- **OAuth client registration** (manual console task — `auth/OAUTH_SETUP.md`) and
  the live real-account runs (`imap-spike` Layer 3, `ai` LiveSmokeTest).

## Step docs

Per-step design + verified/deferred notes: `data-layer/STEP2.md`,
`auth/STEP3.md`, `sync/engine/STEP4.md`, `ui/STEP5.md`, `background/STEP6.md`,
`ai/STEP7.md`, `smtp/send/SMTP.md`, and the spike report `imap-spike/SPIKE.md`.
