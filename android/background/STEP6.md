# Background Sync — Foreground Service + WorkManager (Plan Step 6 / §2)

The plan's "real architectural difference": Android's process lifecycle, not
sockets. Implements the AquaMail-style model — a foreground service holding live
IMAP IDLE while enabled, WorkManager periodic polling as the fallback, exposed as
a **per-account IDLE/polling setting** — with the scheduling policy verified
off-device.

## What's here

| Path | Role | Built here? |
|---|---|---|
| `policy/` | **Scheduling + notification policy, pure Kotlin** | ✅ `gradle test` (8/8) |
| `service/` | **The Android machinery**: foreground IDLE service, WorkManager worker, orchestration, battery-opt, manifest | ❌ (Android SDK + WorkManager on Google Maven — blocked) |

The mechanics that decide *when and how* background sync runs are pure and
verifiable; the framework wiring (a `Service`, a `CoroutineWorker`) is thin.

## Verified here (`policy`, `gradle test`, 8/8)

| Proof | Confirms (plan §2) |
|---|---|
| `effectiveMode_fallsBackToPoll_whenServerLacksIdle` | IDLE requested but unsupported → automatic safety-interval polling |
| `foregroundService_runsWhenAppOpen_orAnyIdleAccount` | FGS runs iff app open OR an IDLE account is live |
| `idleAccounts_excludeUnsupported` | Only IDLE-capable accounts get a live connection |
| `workerInterval_isTightestCadence_clampedTo15` | One periodic worker at the tightest cadence, clamped to Android's 15-min floor |
| `accountsDue_respectPerAccountIntervalWithinOneWorker` | A 15-min worker still honours 30/60-min per-account choices |
| `pollSchedule_anchoredNextRun` | Anchored polling stays on a stable cadence (AquaMail-style) |
| `backoff_isExponential_andClamped` | Failed-sync backoff 30→60→120…, clamped to 1h |
| `notification_truncatesAndPluralizes` | New-mail notification: account title, sender+subject body, "+N more", truncation |

## The Android machinery (deferred build — `service/`)

- **`ImapIdleForegroundService`** — one blocking-`idle()` thread per IDLE account
  (the exact model **proven end-to-end in the spike, CAP 2**;
  `usesocketchannels=false`, reconnect on drop). On an EXISTS push it runs the
  Step 4 sync and posts a notification. Persistent notification +
  `foregroundServiceType="dataSync"`.
- **`SyncWorker`** — periodic `CoroutineWorker`; syncs only the accounts due
  (verified `accountsDue`), runs the Step 4 engine, lets WorkManager back off on
  failure. New mail also reaches the UI via Room `Flow` (Steps 2/5).
- **`SyncManager`** — executes the policy: start/stop the FGS and enqueue the
  worker on app start, pref change, and foreground/background transitions.
- **`BatteryOptimization`** — requests the Doze exemption *when the user enables
  IDLE* (with rationale), per plan §2.
- Manifest: service + FOREGROUND_SERVICE(_DATA_SYNC), POST_NOTIFICATIONS,
  REQUEST_IGNORE_BATTERY_OPTIMIZATIONS.

## How it wires to the other steps

- **Step 1 (spike):** the FGS holds IDLE exactly as CAP 2 proved (blocking
  `idle()` on a thread, no socket channels).
- **Step 3 (auth):** each IDLE/poll connect uses a fresh XOAUTH2 token.
- **Step 4 (sync):** both paths call `SyncEngine.syncAccount`.
- **Step 5 (UI):** the per-account IDLE/poll toggle is a settings screen writing
  `AccountSyncPref`; results surface through Room `Flow`.

## Deferred (needs the Android app project)

- Compile of `service/` (Android SDK + WorkManager) and instrumented
  service/worker tests. The scheduling decisions are verified above; the IDLE
  mechanics are proven in the spike — what remains is device wiring.
- Notification channels + the ongoing "syncing" notification (app
  `NotificationFactory`).
- Per-account settings persistence (DataStore) + the settings UI.
- **Out of scope v1 (plan §7):** FCM/webhook push — would reintroduce a server.

## Run the verification

```bash
cd android/background/policy
gradle test      # 8 passed
```
