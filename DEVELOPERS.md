# Orbit Mail — Developer Guide

Technical documentation for building, configuring, and contributing to Orbit Mail. For end-user installation and usage, see [README.md](README.md).

## Requirements

- **Node.js** 20 or later
- **Linux** desktop (developed on Linux Mint Cinnamon; other desktops supported)
- **Build tools** — needed for the `better-sqlite3` native module (`build-essential`, Python 3, etc.)
- **OAuth credentials** — required for Gmail and Microsoft 365 during development (see [OAuth setup](#oauth-setup))

## Quick start

```bash
git clone <your-repo-url> orbit-mail
cd orbit-mail
npm install
cp .env.example .env   # optional — Gmail/O365 only, and can be entered in-app instead
npm run dev
```

If Electron fails to start because `ELECTRON_RUN_AS_NODE` is set in your shell:

```bash
unset ELECTRON_RUN_AS_NODE
npm run dev
```

### Dev app menu launcher

Generates a `.desktop` file that runs `npm run dev` from the project directory:

```bash
npm run icons
npm run install:desktop
```

If the launcher icon is missing, run `npm run icons` before `npm run install:desktop`.

## OAuth setup

Everyone running Orbit Mail supplies their own OAuth app credentials — this is the design, not a gap (see [Known limitations](#known-limitations)). They can be entered in the Add Account dialog, placed in `~/.config/orbit-mail/.env`, or exported in the environment.

**Credentials are never built into a package.** This is a hard rule (CLAUDE.md, rule 5). A build must be safe to hand to someone else, and anything compiled into the bundle ships with it — the builder would be distributing their own Google client secret and Microsoft app identity, with abuse landing on their Cloud project, and a package cannot be recalled. Inlining `.env` at build time via a Vite `define` is the obvious way to make packaged sign-in "just work"; it is prohibited here. `npm run test:imap` fails if any credential value appears in `out/main/index.js`, or if the build config gains OAuth constants.

**Where credentials come from at runtime**, first hit wins:

1. **The process environment** — a developer's `.env` (loaded by dotenv in `main.ts`), or an operator export.
2. **`~/.config/orbit-mail/.env`** — how someone running a packaged build supplies their own. Same `KEY=value` format; environment variables win over it.
3. **Entered in the app** — picking Gmail or Microsoft 365 in Add Account with nothing configured prompts for that provider's credentials, stored encrypted via `safeStorage` (as the Anthropic key is). Values are never read back out to the renderer: the UI is told only whether a provider is usable, which keys the environment already supplies, and whether encryption is available.

Building without credentials is the normal case for anything you intend to distribute, and is not an error: sign-in then fails with a message naming both locations above.

```bash
cp .env.example .env
```

### Google (Gmail)

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project and enable the **Gmail API**
3. Configure the OAuth consent screen (**External**)
4. Create credentials → **Desktop app**
5. Add the `https://mail.google.com/` scope to the consent screen (this is the only scope that grants IMAP/SMTP access, and Google classes it as **restricted**)
6. Copy the Client ID and Client Secret into `.env`:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Gmail notes**

- IMAP must be enabled in each Gmail account's settings.

**Who can sign in (publishing status)**

The code accepts any Gmail account; what limits sign-in is your OAuth app's publishing status:

| Status | Who can sign in | Caveats |
| --- | --- | --- |
| **Testing** | Only Google accounts on the **test users** allowlist (max 100) | Refresh tokens **expire after 7 days**, so accounts must re-auth weekly |
| **In production**, unverified | **Any** Gmail account | Users see an "unverified app" warning to click through; hard cap of **100 total users**; refresh tokens no longer expire at 7 days |
| **In production**, verified | **Any** Gmail account | No warnings, no user cap; requires brand verification + an annual **CASA security assessment** for the restricted scope (weeks to complete) |

To let **any** Gmail account sign in: OAuth consent screen → **Audience** → **Publish app**. Each new user clicks **Advanced → Go to Orbit Mail (unsafe)** past the unverified-app screen until you complete full restricted-scope verification (only needed for wide public distribution).

#### Full verification & CASA (public distribution only)

You only need this to **remove the unverified-app warning and exceed 100 users** — i.e. to distribute Orbit Mail so anyone can install it and sign in without registering their own credentials. For personal use or a small group, the unverified-production path above costs nothing; skip this section.

Because `https://mail.google.com/` is a **restricted** scope (the strictest tier), full verification is two layers:

1. **OAuth app verification** (brand + app review) — *free*, but requires a domain you own and have verified, a public homepage and **privacy policy** hosted on it, per-scope justifications, and a YouTube demo of the consent flow. Google reviews manually; expect days to weeks.
2. **CASA** (Cloud Application Security Assessment) — an **annual, paid** security assessment by a Google-authorized third-party assessor (via the App Defense Alliance), plus ongoing compliance with Google's **Limited Use** policy (no ads, restricted human review, no data resale). Cost is assessor- and complexity-dependent — roughly **low single-thousands up to ~$15k USD per year** — and it **recurs every year**. A remediation round adds cost if the assessment finds gaps.

There is no lighter Gmail scope that avoids this — the narrower Gmail API scopes (`gmail.modify`, `gmail.readonly`, …) are *also* restricted, so a full mail client can't design its way around CASA.

**How the big OSS clients absorb it:** Thunderbird (Mozilla/MZLA) and Evolution/Geary (GNOME) each maintain one verified client and complete the assessment at the org level, so individual users never see a warning. A solo/indie project can't realistically sustain a recurring four-to-five-figure annual assessment for a free app — which is exactly why Orbit Mail uses bring-your-own-credentials instead.

Figures are ballpark and the program changes over time; get current quotes from ADA-authorized assessors before budgeting. Microsoft's platform has **no equivalent** restricted-scope assessment for the IMAP/SMTP flow used here.

### Microsoft (Office 365 / Outlook)

1. Open [Microsoft Entra admin center](https://portal.azure.com/) → **App registrations** → **New registration**
2. Set **Supported account types** to match the accounts you'll sign in with (e.g. _Accounts in any organizational directory and personal Microsoft accounts_ for both work and outlook.com)
3. Under **Authentication** → **Add a platform** → **Mobile and desktop applications**
4. Add the loopback redirect URI **exactly**: `http://127.0.0.1/callback`
   - Entra ignores the port for loopback URIs, so this single entry covers the random port Orbit Mail listens on. The host (`127.0.0.1`) and path (`/callback`) must match.
5. Under **Authentication** → **Advanced settings**, set **Allow public client flows** to **Yes** (required for the desktop sign-in + refresh-token flow)
6. Copy the **Application (client) ID** into `.env`:

```env
MICROSOFT_CLIENT_ID=your-microsoft-client-id
MICROSOFT_TENANT_ID=common
```

**Microsoft notes**

- **You do not need to add API permissions in the portal.** Orbit Mail requests the IMAP/SMTP scopes (`IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access`) dynamically at sign-in, and you consent in the browser. This is why "Office 365 Exchange Online" not appearing under **API permissions → APIs my organization uses** does not matter for this flow.
- That API only appears for tenants with an active Exchange Online license; for personal Microsoft accounts it is absent by design. If your tenant admin requires _pre-consent_, you can add it by searching the GUID `00000002-0000-0ff1-ce00-000000000000`, but it is optional here.
- Your tenant administrator must allow OAuth-based IMAP/SMTP (some tenants disable IMAP/SMTP entirely).
- `MICROSOFT_TENANT_ID=common` works for most cases; use your specific tenant GUID to restrict sign-in to one organization.

## AI (optional)

The AI features — per-message **Analyze** and the folder **Tasks** sweep — are off unless the user supplies an Anthropic API key. Unlike the OAuth credentials above, this key is **not** read from `.env`: it's entered in-app (✦ toolbar button → AI settings), encrypted with Electron `safeStorage`, and stored in the `app_preferences` table under `ai_api_key`. So there is nothing to configure at build time for AI.

`electron/services/ai-service.ts` uses `@anthropic-ai/sdk` with model `claude-opus-4-8` and structured output. Message content is sent to Anthropic only when the user triggers a feature. On **Analyze**, the user can opt to include a message's attachments for extra context (text extracted inline; images and PDFs sent as native content blocks) — the UI prompts first because attachments increase token usage.

**Caching.** Per-message analysis is cached on the `messages` row (`ai_analysis` / `ai_analysis_at`). The Tasks sweep is also incremental:

- The sweep scans **unread** mail by default or **all** messages in the folder (`SweepScope`, chosen in the dialog).
- Each message's extracted tasks are cached on its own row (`sweep_cache` = JSON `{ task, priority }[]`, `sweep_cache_at`). A NULL cache means "never analysed"; an empty array means "analysed, produced no tasks". A sweep only sends messages whose cache is NULL, so re-sweeping an unchanged folder makes **no** API call — the result reports `freshCount: 0`. The cache is a partial column so ordinary sync/flag updates in `upsertMessage` leave it intact, and it cascade-deletes with the message.
- Sweep results are persisted per folder in the `sweep_tasks` table (composite PK `(folder_id, id)`, where `id` is a stable dedupe key of source message + normalised task text). `open` rows are the outstanding tasks and are replaced on each sweep; `completed` rows are the user's ticked-off history (pruned after 30 days). Completed tasks are fed back into the prompt ("do NOT list these again") and filtered client-side so they never resurface. Per-folder sweep metadata (last run time, count, scope) lives in `app_preferences` under `ai_sweep_meta`.
- Opening the Tasks dialog calls `ai:getTasks` (a pure DB read, no tokens); `ai:sweep` runs a fresh incremental sweep; `ai:completeTask` / `ai:reopenTask` toggle a task's status. `ai:exportTasks` writes the current list to a Markdown file — the renderer builds the Markdown (`src/utils/taskExport.ts`) and main handles the save dialog + file write.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Renderer (React + Zustand)                             │
│  Three-pane UI · Compose · Search · Preferences         │
└───────────────────────────┬─────────────────────────────┘
                            │ typed IPC (contextBridge)
┌───────────────────────────▼─────────────────────────────┐
│  Main process (Electron)                                │
│  IMAP sync · SMTP send · OAuth · IDLE · Notifications   │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│  SQLite (better-sqlite3 + Drizzle)                      │
└─────────────────────────────────────────────────────────┘
```

| Layer | Technology |
|-------|------------|
| Shell | Electron 39, electron-vite |
| UI | React 18, TypeScript, Zustand, Phosphor Icons |
| IMAP | imapflow (sync, IDLE, move, flags) |
| POP3 | node-pop3 (inbox-only sync) |
| SMTP | nodemailer |
| Parsing | mailparser |
| OAuth | google-auth-library, @azure/msal-node |
| AI (optional) | @anthropic-ai/sdk (Claude Opus 4.8) |
| Storage | better-sqlite3, Drizzle ORM |
| HTML sanitization | DOMPurify |

### Sync model

- **Initial sync** — up to 200 messages per folder (UID-sorted batch)
- **Incremental sync** — UID-based delta fetch; only new UIDs since `highestSyncedUid`
- **Background poll** — POP3 every 20s; IDLE-capable IMAP accounts every 90s (IDLE already push-syncs their inboxes), plus one immediate catch-up sync shortly after launch. Accounts sync in parallel.
- **IMAP IDLE** — inbox folders on supported accounts for near-realtime delivery, including live flag changes and expunge (deletion) pushes
- **Server-side reconciliation** — sync detects messages expunged on the server and removes them from the local cache; flag changes propagate in both directions (`imap-idle.ts`, `imap-sync.ts`)
- **Connection pool** — one reused IMAP client per account (`imap-pool.ts`) with a
  per-account operation mutex and 30s idle-close, so a batch of server ops shares a
  single connection instead of reconnecting each time. Kept separate from the IDLE
  monitor's persistent client.
- **Batched writes** — each folder's fetched messages upsert in one transaction
- **Unread counts** — recalculated from local message read state after fetch (kept in sync with the message list)

### Threading

- Each message stores `in_reply_to`, `references`, and a derived `thread_id`
  (`thread-util.ts`: `References[0]` root → `In-Reply-To` → own Message-ID →
  normalized-subject fallback). Grouping is always scoped by `(account_id,
  thread_id)`.
- The list shows one row per thread in the current folder (`listThreads`, window
  functions); opening a thread pulls the **whole conversation across folders**
  (`getThread`), so received + Sent messages interleave in the reader.
- Search results stay flat (single-message reader); a one-message thread renders
  like an ordinary message.

### Search

- **Local search** — scope-aware substring `LIKE` over the cached `messages` table
  (`searchMessages` in `db-service.ts`). The scope (`SearchField`) selects the
  columns matched: `all` (From/To/Subject/Snippet/Body), `from`, `to`, `subject`,
  or `body`. The chosen scope is persisted in `UiPreferences`.
- **Server-side fallback** — when local search returns nothing (or on the explicit
  *Search whole mailbox* action), `searchServerMessages` (`imap-sync.ts`) runs a
  live IMAP search — Gmail `X-GM-RAW` over *All Mail*, or `from`/`to`/`subject`/`body`
  SEARCH keys over the INBOX for plain IMAP — imports the matches into the DB so they
  open like any cached message, and returns them. This reaches mail outside the local
  sync window. POP3 has no server-side search.
- **There is no full-text index.** A contentless FTS5 table (`messages_fts`) used to be
  maintained on every synced message and was never queried — the search path has always
  used `LIKE`. It could not have worked either: a contentless FTS5 table reads every
  column back as NULL, so its delete-by-`message_id` never matched and it accumulated a
  duplicate row per re-index. It was removed (#36) rather than repaired, taking ~0.5ms
  per synced message and ~8MB with it.
- If full-text search is wanted later, build it as an **external-content** FTS5 table
  over `messages` (`content='messages'`, joined on the implicit `rowid`) maintained by
  triggers — that stores no duplicate text and makes deletes work. Note it changes
  matching: FTS matches whole tokens, so `mail` would stop matching `gmail`, which
  today's substring `LIKE` does. Preserving that needs prefix or trigram tokenisation.

### Performance notes

- **Optimistic UI** — read/star/flag/move/delete update the list (and open reader)
  immediately and roll back on IPC failure; the reader header paints from the list
  summary while the body loads. See `patchMessageInList` in `mailStore.ts`.
- **Virtualized list** — the message list renders through `virtua`'s `VList` with a
  memoized row, so DOM node count stays roughly constant regardless of folder size.
- **Reference-preserving refresh** — `mergeMessageList` reuses unchanged row objects
  on background refresh, so memoized rows skip re-render and the list doesn't flicker.
- **DB** — WAL + tuned pragmas; `COUNT(*)` for counts; list queries project just the
  summary columns (no body blobs); partial index on unread rows.
- **Freelist reclaim** — deleting mail (prune, account removal, empty folder) frees
  pages that SQLite keeps on the freelist, so the file only ever grew (`auto_vacuum`
  is off). `reclaimFreelistIfLarge` runs `VACUUM` from `window-all-closed`, after the
  window is gone so the ~2s synchronous block is invisible, and only when the freelist
  is ≥25% of the file and ≥20MB. Self-throttling — `VACUUM` zeroes the freelist — so it
  is rare; small databases are left alone.
- **Thread listing** — threads are keyed by `COALESCE(thread_id, id)`, which no plain
  column index can serve, so `listThreads`/`countThreads` were scanning the account and
  building temp b-trees on every folder switch. Two expression indexes fixed that (#35):
  `(account_id, COALESCE(thread_id, id), date)` for the per-thread `MAX(date)`, and
  `(folder_id, account_id, COALESCE(thread_id, id), is_read)` as a covering index for
  "which conversations are in this folder" — `account_id` must precede the expression or
  the `DISTINCT` cannot use it. Measured on a 3.3k-message profile: list 57.7→35.4ms,
  count 3.9→1.0ms. **Still linear in account size**: the remaining cost is `MAX(date)`
  per thread plus a sort of every thread before `LIMIT`. Going sub-linear needs a
  denormalised thread key and last-activity date.
- **Connection lane** — `imap-pool` serialises operations per account. Anything holding
  the lane across many folders blocks user actions behind it; the flag reconcile now
  re-borrows per folder for that reason (#34).

### Project layout

```
orbit-mail/
├── electron/           # Main process: sync, OAuth, DB, IPC
│   ├── main.ts
│   ├── preload.ts
│   ├── db/             # Schema, migrations
│   └── services/       # imap-sync, smtp-send, oauth-*, etc.
├── src/                # Renderer: React UI
├── shared/             # Types shared between main and renderer
├── build/              # Icons and .desktop template
├── scripts/            # Icon generation, dev launcher install
└── release/            # electron-builder output (after dist)
```

### Key modules

| Path | Role |
|------|------|
| `electron/services/imap-sync.ts` | IMAP sync, UID tracking, background poll (accounts in parallel), expunge reconciliation, server-side search |
| `electron/services/imap-pool.ts` | Pooled per-account IMAP client + per-account op mutex |
| `electron/services/imap-idle.ts` | IMAP IDLE per account (new mail, flag + expunge push) |
| `electron/services/db-service.ts` | SQLite CRUD, scope-aware search, unread recalculation |
| `electron/services/ai-service.ts` | Optional AI: message analysis, incremental inbox task sweep (unread/all scope, persisted + cached tasks), encrypted Anthropic key storage |
| `electron/preload.ts` | Typed `window.orbitMail` IPC bridge |
| `shared/types.ts` | Shared types and `OrbitMailAPI` contract |
| `src/stores/mailStore.ts` | Renderer state, message list refresh |
| `src/stores/persistence.ts` | UI preference persistence |

Local database path: `~/.config/orbit-mail/data/orbit-mail.db`

## Security posture

What the app defends against, and the tests that keep it that way. All of this
was added or hardened in a July 2026 audit pass; `TODO.md` lists what remains.

### Rendered email is hostile input

A message body is attacker-controlled HTML injected into the app's own document,
which carries the full-privilege preload. Three independent layers:

1. **Sanitizer** — `src/utils/sanitizeEmailHtml.ts`, one shared helper for every
   render path. DOMPurify's defaults are tuned for "safe HTML in a web page", not
   for a document holding an IPC bridge, so it additionally forbids navigation
   sinks (`form`, `button`, `input`, and `action`/`formaction`/`method`/`target`),
   embedding sinks (`iframe`, `object`, `embed`), and document-level tags
   (`base`, `meta`, `link`). An `afterSanitizeAttributes` hook strips
   `position: fixed|sticky|absolute` and its offsets from `style` attributes —
   DOMPurify never inspects style *contents*, which otherwise left the reader
   pane paintable over with a convincing fake UI.
2. **Navigation** — `blockOffAppNavigation` in `main.ts` cancels `will-navigate`
   and `will-frame-navigate` to anything outside the app shell, forwarding
   `http(s)` to the OS browser. Without it, a form submit inside an email could
   navigate the renderer to an attacker page that inherits `window.orbitMail`.
3. **CSP** — injected per mode by the `orbit-csp` plugin in
   `electron.vite.config.ts`. Production gets `script-src 'self' file:`;
   the dev server additionally needs `'unsafe-inline'` for the react-refresh
   preamble. Neither uses `'unsafe-eval'`. `form-action`, `object-src`,
   `frame-src` and `base-uri` are all `'none'`.

**Not defended:** remote content loads unconditionally, so opening a message
confirms the read and reveals the client's IP to the sender. There is no
block-remote-images preference yet.

### Transport

`imapConnectionSecurity()` maps `'starttls'` to `{ secure: false, doSTARTTLS: true }`,
making the upgrade **mandatory** — ImapFlow's default is opportunistic and
continues in the clear when the server does not advertise STARTTLS. The SMTP
OAuth transport sets `requireTLS` for the same reason. Consequence worth knowing:
an account configured as STARTTLS against a server that does not offer it now
fails to connect rather than silently sending credentials unencrypted.

### OAuth

Both flows send a per-attempt random `state` and an S256 PKCE challenge, and the
loopback listener refuses to hand back a code unless `state` matches. The
listener is reachable by anything that can talk to localhost — including any web
page the user has open — so without that check a hostile page could deliver its
own authorization code and bind its mailbox to this client. A mismatched
callback is answered and ignored rather than treated as an error, so a hostile
page cannot abort a legitimate sign-in by racing it. The listener also times out
after 5 minutes and closes on every path.

### Credentials

Rule 5 in CLAUDE.md: **never put credentials in a build**. See
[OAuth setup](#oauth-setup) for where they come from instead. Account passwords
and tokens are encrypted with `safeStorage`; when no keyring is available that
degrades to base64, which is an open item in `TODO.md`.

### Attachments

Opening an attachment whose extension can execute (`.desktop`, `.sh`, `.jar`,
`.exe`, …) prompts first, naming the real extension — the point of a
`.pdf.exe` is that the eye stops reading at `.pdf`. See
`electron/services/attachment-safety.ts`. Attachment files are written `0600`
and keyed by attachment id, so two parts sharing a filename cannot overwrite
each other.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build main, preload, and renderer for production |
| `npm run preview` | Preview production build |
| `npm run icons` | Regenerate PNG icons from `build/icon.svg` |
| `npm run install:desktop` | Install a dev `.desktop` launcher |
| `npm run test:imap` | Integration suite against a real IMAP/SMTP server (see below) |
| `npm run dist` | Build icons, compile, and package (.deb + AppImage) |
| `npm run dist:deb` | Debian package only |
| `npm run dist:appimage` | AppImage only |

## Integration tests (GreenMail)

`npm run build` is still the main verification gate, and there is no unit-test
framework. The one exception is the sync layer, where the failure modes are
protocol-level and expensive to get wrong (silent TLS downgrade, push that
stops arriving, a cache wipe that loses mail). Those are covered by an
integration suite that runs against a real mail server. It has since grown to
cover the security controls, account-data hygiene, and a few pure-logic
invariants too — the areas in the table below — because those are the things
that fail silently.

```bash
npm run test:imap           # start GreenMail, run the suite, tear it down
npm run test:imap -- --keep # leave the container up for poking at afterwards
```

**Requires Docker.** The runner (`scripts/imap-integration.mjs`) starts
[GreenMail](https://greenmail-mail-test.github.io/greenmail/) as
`orbit-mail-greenmail-test` (IMAP 3143, IMAPS 3993, SMTP 3025), builds the
suite with esbuild, and runs it inside a **windowless Electron main process** —
the DB layer needs `app.getPath()`, and `better-sqlite3` is compiled against
Electron's ABI, so plain `node` cannot host it. `userData` is redirected to a
temp directory, so the suite never touches your real mail database.

`scripts/imap-integration.suite.ts` imports the app's own services rather than
reimplementing them, so it exercises the shipping code paths:

| Area | What it asserts |
|------|-----------------|
| OAuth | The loopback listener accepts a callback only when its `state` matches this attempt's, so an injected authorization code cannot complete a sign-in; a genuine callback still works after rejected ones; an abandoned sign-in times out and releases the port. (Needs no mail server, but rides along here rather than adding a second test command.) |
| TLS | `'starttls'` requires the upgrade and *refuses* a server that does not offer it — GreenMail's plain port advertises no STARTTLS, so it is an accurate stand-in. Includes a guard proving the old mapping would have logged in over plaintext. |
| Sync | Seeded messages reach the local cache with correct subjects; a repeat sync is a no-op. |
| UIDVALIDITY | After a validity reset the cache is *rebuilt to its previous size*, not truncated to one batch, with no duplicate rows. |
| IDLE | Push works, survives a full server restart, and resumes afterwards. |
| Responsiveness | A mark-read issued while a flag reconcile is in flight is not stuck behind the whole pass — `imap-pool` serializes per account, so anything holding the lane across every folder blocks user actions. |
| Send | SMTP submission succeeds; the message is filed in `Sent` exactly once, shares its Message-ID with the delivered copy, and does not carry `Bcc` in its headers. |
| Attachments | Two parts sharing a filename get distinct cache paths **and** distinct content — the second used to overwrite the first on disk *and* resolve to the first MIME part, so it was never downloaded. Also that executable extensions are classified for the open-warning, and ordinary documents are not. |
| OAuth config | Credentials resolve environment-first, fall back to values entered in the app, and the status payload never carries a value back to the renderer. Plus the rule-5 guards: no OAuth constants in the build config, no placeholders in the bundle, and no `.env` value present in `out/main/index.js`. |
| Launcher badge | The Unity `LauncherEntry` signal is a valid D-Bus object path (a percent-encoded app URI is not, and every emit silently failed), the count is typed `int64`, and zero hides the badge. |
| IPC contract | Every channel `preload.ts` invokes has an `ipcMain.handle` in `main.ts`. Added after two channels were wired into the preload but not main — clean build, green suite, runtime failure. |
| Docs | Every `npm run` script and file path the docs cite exists, the documented Electron version matches `package.json`, and no document claims credentials are built into a package (CLAUDE.md rule 6). Prose is not checked; references are. |
| Account removal | Deleting an account removes its AI Tasks (per-folder, and unified-inbox tasks tied to its messages) as well as its mail — `sweep_tasks` has no foreign key, so the cascade misses them — while another account's tasks survive. |
| Task-orphan cleanup | The one-time migration for tasks left by pre-fix deletions removes a per-folder orphan (folder gone), leaves a unified task whose source message is merely missing (could be a valid todo that aged out of the cache), and is idempotent. |
| DB maintenance | The freelist reclaim fires only above the 25% / 20MB threshold and not on a small or freshly compacted database; the real `VACUUM` path shrinks the file and zeroes the freelist. |

Notes for anyone extending it:

- A first-ever sync of a folder only caches the newest `SYNC_BATCH_SIZE` (200)
  messages — that is the app's initial-sync depth, not a bug. To build a cache
  larger than one batch, sync, append newer mail, and sync again.
- The UIDVALIDITY reset is triggered by writing a bogus stored validity rather
  than by recreating the mailbox, so the trigger does not depend on how
  GreenMail allocates validity numbers.
- GreenMail is in-memory: a restart empties every mailbox but keeps the user.
- A check reported as `todo` documents a known-open bug and does not fail the
  run, so the suite can describe reality without going red. There are none at
  present; use `todo()` rather than deleting a check when you find a bug you are
  not fixing yet.
- The suite exits non-zero on any failure and runs in CI on every push and pull
  request (`.github/workflows/ci.yml`), alongside `npm run build`. Docker is
  preinstalled on the runners, and the runner switches to headless Ozone when
  there is no `DISPLAY`, so no xvfb is needed.
- On failure the runner prints GreenMail's last 40 log lines before removing the
  container — on CI that is the only view of the server side.
- CI deliberately does not run `tsc -b`; see the note in the workflow.

## Building & packaging

Regenerate icons before building distributables:

```bash
npm run icons
```

### Build from source

```bash
npm run build
```

Output goes to `out/` (main, preload, and renderer bundles).

### Linux packages

```bash
npm run dist          # .deb + AppImage
npm run dist:deb      # .deb only
npm run dist:appimage # AppImage only
```

Install the Debian package:

```bash
sudo dpkg -i release/Orbit\ Mail-*.deb
```

Packaged builds install a `.desktop` launcher with `StartupWMClass=orbit-mail` for correct taskbar/window grouping on Cinnamon and other desktops. `mailto:` handling is opt-in so the app does not hijack links from browsers or admin consoles.

**Packages never contain OAuth credentials** (CLAUDE.md rule 5, enforced by `npm run test:imap`). A build made with a `.env` present is byte-identical in this respect to one made without: credentials are resolved at runtime from the environment, `~/.config/orbit-mail/.env`, or the Add Account dialog. There is nothing to rebuild after changing them.

## Troubleshooting (development)

**Account add fails (Google)**  
Confirm IMAP is enabled, the consent screen includes `https://mail.google.com/`, and your account is a test user if the app is in Testing mode.

**Account add fails (Microsoft)**  
Register the redirect URI exactly as `http://127.0.0.1/callback`, set **Allow public client flows** to **Yes**, and confirm your tenant allows OAuth IMAP/SMTP. You do **not** need to add "Office 365 Exchange Online" API permissions — scopes are consented in the browser at sign-in. If you see "no refresh token", re-check that public client flows are enabled and try again.

**`better-sqlite3` compile errors on install**  
Install build essentials: `sudo apt install build-essential python3`.

**Electron won't start (`ELECTRON_RUN_AS_NODE`)**  
Run `unset ELECTRON_RUN_AS_NODE` before `npm run dev`.

**Unread badge ahead of message list**  
Folder unread counts are updated after messages are persisted during sync. If you see a mismatch, check for stale renderer refresh timing in `src/stores/mailStore.ts` and `syncFolder` in `electron/services/imap-sync.ts`.

## Known limitations

See [`TODO.md`](TODO.md) for the full backlog.

- **Bring-your-own OAuth credentials** — Orbit Mail ships none, and will not: that would mean either embedding the builder's own client secret in every package (prohibited — CLAUDE.md rule 5) or funding Google verification and a CASA assessment for the restricted Gmail scope, which has been declined. Each user registers an OAuth app once and enters the credentials in the app, and clicks through Google's "unverified app" warning per account. Nothing about a packaged build requires editing a file.

## License

MIT
