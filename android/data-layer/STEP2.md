# Data Layer — Room Schema + DAOs (Plan Step 2)

Ports the audited SQLite schema (Step 0 audit §2) to Room entities + DAOs, and
**verifies the SQL contract against a real SQLite engine**.

## What's here

| Path | Role | Built here? |
|---|---|---|
| `room/` | **The deliverable** — Room `@Entity` / `@Dao` / `@Database` Kotlin code that drops into the Android app | ❌ (needs Android SDK + Google Maven — both blocked in the sandbox) |
| `schema-verify/` | A JVM harness that runs the exact schema DDL + the hard DAO queries against `sqlite-jdbc` and asserts behaviour | ✅ `gradle test` |

## Why split this way

Room and `androidx.sqlite` are published only on **Google's Maven**, which this
environment's proxy blocks (`maven.google.com` → 301 → `dl.google.com` 403), and
there is no Android SDK. So the Room code can't be compiled/run here. But the
part that actually carries risk — the **SQL logic** (window-function thread
collapse, partial-index unread counts, cascade deletes, scoped search) — is
engine behaviour, not Room behaviour. `schema-verify/` proves that logic against
a real modern SQLite (`sqlite-jdbc`, bundles SQLite ~3.49) reachable from Maven
Central. Each Room `@Query` mirrors a query proven there.

## Verified here (`gradle test` in `schema-verify/`, 9/9 green)

| Proof | What it confirms |
|---|---|
| `schemaApplies_andForeignKeyCascade` | Full DDL applies; deleting an account cascades folders → messages → attachments |
| `uniqueFolderUid_rejectsDuplicate` | `UNIQUE(folder_id, uid)` — the incremental-sync identity constraint |
| `partialUnreadIndex_isUsedByRecount` | `EXPLAIN QUERY PLAN` shows the unread recount uses `messages_folder_unread_idx` (partial index) |
| `threadCollapse_windowFunction_oneRowPerThread` | `ROW_NUMBER/COUNT/MAX OVER (PARTITION BY thread_id)` collapses to one latest row per thread with count + hasUnread |
| `unifiedInbox_spansInboxFoldersOnly` | Unified inbox = inbox folders across accounts, excluding Sent and Gmail virtual views |
| `getThread_crossFolder_byAccountAndThread` | Whole conversation across folders, ordered by date (Sent interleaved) |
| `scopedLikeSearch` | Scope-aware `LIKE` (all vs. from), incl. From/To (audit §9 v1 path) |
| `sweepTasks_replaceOpen_andComplete` | Replace-open keeps completed history; composite PK `(folder_id, id)` dedupes |
| `fts5_optional_searchPath` | FTS5 `MATCH` works — kept as a future option (LIKE is the v1 path) |

## Entity ↔ verified DDL mapping

The single source of truth for the DDL is `schema-verify/.../OrbitSchema.kt`,
kept in lockstep with the Room entities:

| Room entity | Table | Notes |
|---|---|---|
| `AccountEntity` | `accounts` | **No `token_blob`** — credentials go to Keystore (audit §6) |
| `FolderEntity` | `folders` | `highest_modseq` is TEXT (64-bit MODSEQ); `folders_account_idx` |
| `MessageEntity` | `messages` | 5 `@Index` (incl. unique `folder_id,uid`); **partial unread index created in `OrbitDatabase` callback** (Room can't express `WHERE`) |
| `AttachmentEntity` | `attachments` | `local_path` null until fetched; FK index |
| `PreferenceEntity` | `app_preferences` | KV; **`ai_api_key` stays out of the DB** → Keystore (audit §7) |
| `SweepTaskEntity` | `sweep_tasks` | composite PK `(folder_id, id)` |

DAOs: `AccountDao`, `FolderDao`, `MessageDao` (the core — window-function thread
lists, unified inbox, UID primitives, flag reconciliation, scoped search, AI
caches), `AttachmentDao`, `PreferenceDao`, `SweepTaskDao`. List reads return
`Flow` for reactive UI (audit §4 — Room Flow replaces the renderer's manual
optimistic-update plumbing); one-shots/writes are `suspend`.

## Deliberate changes from the desktop schema (per audit)

- `accounts.token_blob` **removed** — OAuth tokens / passwords → Android Keystore
  + EncryptedSharedPreferences (a `SecureCredentialStore`, a later step). The DB
  stays credential-free.
- `ai_api_key` is **not** an `app_preferences` row on Android → Keystore.
- Only the **final** schema is modelled (v1) — the desktop's additive `ALTER`
  migrations and one-time backfills are not ported (fresh DB).
- **FTS5 is not the search path** (audit §9): scope-aware `LIKE` is, matching the
  desktop's actual query path and covering From/To. FTS5 is proven viable and
  left as a future option.

## Deferred (needs the Android app project: SDK + Google Maven)

- Room annotation processing (KSP) / compile of `room/`.
- Instrumented DAO tests on device/emulator (`androidx.room:room-testing`) —
  the query behaviours are already proven at the SQL level here; the instrumented
  pass just confirms Room's generated bindings match. Flagged per the repo's
  "note where test coverage is deferred" practice.
- `getThread` participant aggregation (distinct sender names, oldest-first) — the
  row query is verified; the participants list is a small `GROUP_CONCAT`/2nd-pass
  detail to finalize with the UI.

## Run the verification

```bash
cd android/data-layer/schema-verify
gradle test      # 9 passed
```
