# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Golden rules
1. Don't assume. Don't hide confusion. Surface tradeoffs.
2. Minimum code that solves the problem. Nothing speculative.
3. Touch only what you must. Clean up only your own mess.
4. Define success criteria. Loop until verified.
5. **Never put credentials in a build.** Mandatory, no exceptions.
6. **Docs ship with the change.** A feature isn't done until the docs match it.

Orbit Mail is an Electron desktop email client for Linux (IMAP/POP3/SMTP + Gmail/O365 OAuth, optional Anthropic AI features). **[DEVELOPERS.md](DEVELOPERS.md) is the authoritative deep reference** — sync model, threading, search, OAuth setup, AI caching, packaging. This file captures only what's non-obvious for working in the code.

## Rule 5 — no credentials in a build

A build must be safe to hand to another person. Nothing that identifies or
authenticates *this* developer may end up in `out/`, in a `.deb`/AppImage, or in
`app.asar` — not OAuth client IDs or secrets, not API keys, not tokens.

This is not hypothetical: a build-time `define` once inlined the `.env` OAuth
credentials into the main bundle, and `npm run dist:deb` produced a package
containing a real client secret. It was caught during testing, never
distributed, and the mechanism was removed before it reached `main`. Do not
reintroduce it in any form — `define`, `extraResources`, a bundled `.env`, a
constants file, or a "temporary" default.

Credentials are supplied **at runtime, on the machine that runs the app**:

- the process environment (a developer's `.env`, loaded by dotenv in `main.ts`)
- `~/.config/orbit-mail/.env`
- entered in the app and stored encrypted via `safeStorage` (as the Anthropic
  key already is)

A build with no credentials is the correct outcome, not a failure — it warns and
carries on. `npm run test:imap` enforces this: it fails if any configured
credential value appears in `out/main/index.js`, or if the build config gains
OAuth constants.

The counter-argument — that an installed app's client secret is not confidential
under RFC 8252 §8.5 — is a reason not to panic if one leaks. It is **not** a
reason to ship one.

## Rule 6 — docs ship with the change

Update documentation in the **same commit** as the change, not "later". Docs
went from accurate to asserting the opposite within hours more than once here:
README and DEVELOPERS.md both told users OAuth credentials were "baked in at
build time" *after* that was prohibited, and this file carried rule 5 and, forty
lines below it, the sentence rule 5 forbids. Every one of those was written by
the same person who had just changed the code.

The docs and what each is for:

| File | Audience | Update when |
|------|----------|-------------|
| `README.md` | someone deciding whether to use or trust the app | user-visible behaviour, install/setup steps, limitations, privacy or security posture |
| `DEVELOPERS.md` | **authoritative deep reference** | architecture, schema, sync model, security controls, scripts, test coverage, packaging |
| `TODO.md` | backlog and decisions | anything fixed, deferred, or decided against — record decisions, not just tasks |
| `CLAUDE.md` | this file, for agents | conventions and traps that are non-obvious from the code |

Specific triggers — if the change does any of these, the docs move too:

- **Adds or removes an IPC channel** → the contract in `shared/types.ts` is the
  spine; DEVELOPERS.md describes it.
- **Changes the schema** (column, index, table) → DEVELOPERS.md schema notes and
  the schema facts paragraph below.
- **Adds a script or command** → the Scripts table in DEVELOPERS.md *and* the
  Commands section here.
- **Changes security posture** → DEVELOPERS.md → Security posture, and README if
  a user would notice.
- **Removes something documented** → delete the description; do not leave it
  describing a thing that no longer exists (see: the FTS index, documented in
  four places for hours after it was deleted).

`npm run test:imap` enforces the mechanically checkable part: every `npm run`
script and every file path the docs cite must exist, the Electron version they
claim must match `package.json`, and no document may describe credentials as
built into a package. It cannot check prose — that part is on you.

Two habits that prevent the worst of it:

- **Grep before claiming.** Before writing "X works like Y", grep the docs for
  the old claim — stale statements hide in files you did not touch.
- **Document what is *not* handled.** A security or feature section that lists
  only wins is worse than none: remote images still load, credential encryption
  degrades without a keyring, thread listing is still linear in account size.
  Those belong in the docs as plainly as the fixes.

## Commands

- `npm run dev` — dev server with hot reload. If Electron refuses to start, `unset ELECTRON_RUN_AS_NODE` first (it's set in this environment's shell).
- `npm run build` — **this is the verification gate.** It compiles main, preload, and renderer via electron-vite/esbuild. Run it after changes to confirm they're sound.
- `npm run dist` / `dist:deb` / `dist:appimage` — package (runs `icons` + `build` + electron-builder). Packages contain **no** OAuth credentials (rule 5); they are resolved at runtime, so there is nothing to rebuild after editing `.env`.

There is **no unit-test framework and no linter** in this repo. Verification = `npm run build` passes.

The one exception is `npm run test:imap` — 71 checks against a real GreenMail server in Docker, inside a windowless Electron main process (the DB needs `app.getPath`, and `better-sqlite3` is built for Electron's ABI). It covers the sync layer (STARTTLS, sync, UIDVALIDITY rebuild, IDLE reconnect, send, lane contention), the security controls (OAuth loopback `state`, credential handling, attachment classification), and pure-logic invariants (launcher badge signal, IPC contract). It runs in CI on every push. Run it locally after touching anything in `electron/services/`. Details in DEVELOPERS.md → Integration tests.

**Do not treat `tsc -b` as a pass/fail gate.** The source does not cleanly pass a standalone `tsc -b` even on `main` (target/lib and third-party typing mismatches that esbuild transpiles past). Use `npm run build`.

**`npm run dev` fails here** (GPU sandbox crash) — ask the user to click through UI changes. But headless Electron *does* work, which is more than "no GUI testing" implies:

- **Windowless main process** — `app.whenReady()` with no BrowserWindow, plus `app.disableHardwareAcceleration()` and `--no-sandbox`. Hosts the real DB layer, which is how `npm run test:imap` runs.
- **Hidden `BrowserWindow({ show: false })`** — renders real pages; used to verify CSP enforcement, console errors, and whether React mounted. Attach `out/preload/index.js` or the renderer errors on missing IPC.
- **`offscreen: true` hangs forever.** That is the thing that does not work, and what made "the GUI can't run" look absolute.

To inspect state, read the SQLite DB directly with `ELECTRON_RUN_AS_NODE=1`; DB lives at `~/.config/orbit-mail/data/orbit-mail.db`. **Copy the `-wal` file too** — the DB runs in WAL mode, so a copy of just the `.db` can be missing recent commits.

## Process architecture

Three layers, communicating by typed IPC:

- **`electron/`** — main process: IMAP/POP3 sync, SMTP send, OAuth, IDLE, SQLite. Entry `electron/main.ts`; services in `electron/services/`.
- **`src/`** — renderer: React 18 + Zustand three-pane UI. State in `src/stores/mailStore.ts`. `@/` aliases `src/`.
- **`shared/`** — types shared across the boundary. `shared/types.ts` defines `OrbitMailAPI`, the IPC contract.

`tsconfig.node.json` covers `electron/` + `shared/`; `tsconfig.web.json` covers `src/` + `shared/`. These are separate compilation contexts — main-process code cannot import renderer code and vice versa; cross-boundary types go in `shared/`.

## The IPC contract is the spine

Every renderer→main call flows through three files that must stay in lockstep. **Adding or changing a feature that crosses the process boundary means editing all three:**

1. `shared/types.ts` — add the method to the `OrbitMailAPI` interface.
2. `electron/preload.ts` — wire the method to `ipcRenderer.invoke('channel:name', ...)`.
3. `electron/main.ts` — register `ipcMain.handle('channel:name', ...)` (delegates to a service).

Channels are namespaced (`accounts:*`, `messages:*`, `sync:*`, `ai:*`, etc.). The renderer calls them as `window.orbitMail.<namespace>.<method>()`.

## Database: dual source of truth

The schema is defined **twice** and both must be kept consistent:

- `electron/db/schema.ts` — Drizzle table definitions (what query code types against).
- `electron/db/index.ts` — raw `CREATE TABLE` in `initTables` **and** a hand-written, append-only `migrateSchema` sequence of `ALTER TABLE ADD COLUMN` steps run on every startup (there is no Drizzle migration tooling).

**To add a column:** add it to the Drizzle table in `schema.ts`, to the `CREATE TABLE` in `index.ts` (for fresh DBs), and append a new `ALTER TABLE ... ADD COLUMN` step to `migrateSchema` (for existing DBs). Migrations are idempotent-by-position — only append, never reorder or edit existing steps.

Notable schema facts (see DEVELOPERS.md for full rationale): Gmail labels are stored as one message row per folder, deduped by `message_id` at query time; threading is derived (`thread_id`) and always scoped by `(account_id, thread_id)`; AI results cache on the `messages` row (`ai_analysis`, `sweep_cache`) as partial columns so ordinary sync upserts leave them intact; there is **no** full-text index — search is a scope-aware `LIKE` over `messages`, and the old contentless `messages_fts` was removed (it was written on every sync and never queried); thread listing depends on two *expression* indexes on `COALESCE(thread_id, id)`, which `schema.ts` can only describe with `sql\`\`` — the `CREATE INDEX` statements in `index.ts` are what actually run.

## The IPC contract is checked, not just documented

`npm run test:imap` parses `preload.ts` for `ipcRenderer.invoke('channel')` and
`main.ts` for `ipcMain.handle('channel')` and fails if any invoked channel has
no handler. This exists because a change once added two `oauth:` channels to the
preload but not to main: the build was clean, the suite was green, `tsc` was
unchanged, and the app failed at runtime with "No handler registered".

## Working conventions

- Branch from `main` per task; verify with `npm run build`; commit and open a PR/merge when asked (don't fuss over cosmetics).
- The renderer uses optimistic UI (read/star/flag/move/delete patch the list immediately and roll back on IPC failure — `patchMessageInList` in `mailStore.ts`). Preserve that pattern when adding message actions.
