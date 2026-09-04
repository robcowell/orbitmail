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
| `README.md` | someone deciding whether to use or trust the app — **plain language, no internals** | user-visible behaviour, limitations, privacy or security posture as a *user* experiences it |
| `INSTALL.md` | someone installing it, or building their own copy | install/build steps, OAuth app registration, updating and removing |
| `DEVELOPERS.md` | **authoritative deep reference** | architecture, schema, sync model, security controls, scripts, test coverage, packaging |
| `TODO.md` | backlog and decisions | anything fixed, deferred, or decided against — record decisions, not just tasks. **Outstanding work stays at the top**, completed work under `# Done` with its reasoning intact |
| `CHANGELOG.md` | someone deciding whether to update — **plain language, user-facing** | a release goes out. It condenses TODO.md's Done entries into what a user would notice; the *why* stays in TODO.md. `npm run test:imap` checks the README version badge against `package.json`, so those two cannot drift |
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
- **Name the suite file when you grep it.** `scripts/imap-integration.suite.ts`
  holds a NUL byte (an iWork fixture, `'\x00\x01binary'`, ~line 3516). Given the
  path directly, ripgrep reads it as text; reached through a **directory** —
  `rg foo scripts/`, or a repo-wide search — binary detection drops *every* match
  in the file, silently, exit code 1. It is the largest record of what is
  actually tested, and it is the file most likely to answer "is X covered?" with
  a confident, wrong "no". That has already produced a shipped commit deleting a
  true statement from DEVELOPERS.md and filing a gap that did not exist. Confirm
  any "nothing covers this" against the named file, or `rg --text`.
- **`scrollWidth > clientWidth` is not "it scrolls".** With `overflow-x: hidden`
  the metric stays true while the content is clipped and unreachable, so an
  assertion written that way passes against broken CSS — it happened twice in
  one sitting. Set `scrollLeft` and check it moved.
- **Never assert on a formatted date or number.** `toLocaleString` follows the
  machine's locale, so `12,000` here is `12.000` in German and `2 Apr` is
  `Apr 2` in CI. Three assertions were written against a UK machine's output and
  one of them failed in CI; the other two would only have failed for a
  contributor abroad. Compare against the platform's own formatting
  (`` `${(12000).toLocaleString()} conversations` ``) or assert the shape rather
  than the string. `npm run test:store` can be run under `LC_ALL=de_DE.UTF-8`
  to check.
- **Document what is *not* handled.** A security or feature section that lists
  only wins is worse than none: remote images still load, credential encryption
  degrades without a keyring, thread listing is still linear in account size.
  Those belong in the docs as plainly as the fixes.

## Commands

- `npm run dev` — dev server with hot reload. If Electron refuses to start, `unset ELECTRON_RUN_AS_NODE` first (it's set in this environment's shell).
- `npm run build` — **this is the verification gate.** It compiles main, preload, and renderer via electron-vite/esbuild. Run it after changes to confirm they're sound.
- `npm run dist` / `dist:deb` / `dist:appimage` — package (runs `icons` + `build` + electron-builder). Packages contain **no** OAuth credentials (rule 5); they are resolved at runtime, so there is nothing to rebuild after editing `.env`.

- `npm run ui:preview` — serve the built renderer to a browser with the IPC bridge stubbed, so UI changes can be looked at where Electron will not start. Not a test; see the GUI note below.

- `npm run test:e2e` — end-to-end suites through real windows: the send path, and window lifecycle (Docker + a display; not in CI). See below.

There is **no unit-test framework and no linter** in this repo. Verification =
`npm run build` passes, plus five test commands — `test:pure`, `test:db` and
`test:store` (about a second each, no Docker, no Electron), `test:imap` (Docker
+ Electron), and `test:e2e` (Docker + a display). `test:mutants` is a sixth, but
it is a diagnostic rather than a gate.

`npm run test:pure` — pure main-process logic under plain node (~1s, no Docker,
no Electron). `attachment-safety.ts`, `connection-failure.ts`,
`network-reachability.ts`,
`sync-policy.ts`, `thread-util.ts`, `window-geometry.ts` and `zoom.ts` import
nothing at runtime, so they need neither — and
living in `test:imap` made them impossible to mutation-test. **A module bundled
here must import nothing at runtime** (a type-only import is fine — esbuild
erases it, which is why `zoom.ts` qualifies despite naming `electron`); the
moment one needs the DB or Electron it goes to `test:db` or back to
`test:imap`.

`npm run test:db` — the **database layer** under plain node (~1s, no Docker, no
Electron). `better-sqlite3` is built against Electron's ABI, so nothing that
imported the DB could be loaded by `node`; `scripts/sqlite-node-shim.mjs` adapts
node's built-in SQLite to the same shape and esbuild swaps them at bundle time.
The code under test is the real `db-service.ts`, schema and migrations.

**The assertions live in `scripts/db-contract.suite.ts`, and both runners execute
it** — this one, and `test:imap` on the real driver at the end of its run. That
is what makes the shim trustworthy: a difference it hides fails there. It has
already earned it — an assertion passed here and failed under `test:imap`,
correctly, because the contract had assumed it owned the only inbox. The contract
creates and removes its own account for that reason: it must not assume an empty
database.

`npm run test:mutants` — changes one token at a time in the pure renderer and
main-process modules and the database layer, and checks the matching fast suite
notices. A surviving mutant is a decision no
assertion depends on: the code could be wrong there and nothing would say. Run
it after touching `src/utils/*.ts`, any module in `test:pure`, or `db-service.ts`;
`--strict` exits non-zero on any survivor
not justified in `scripts/mutants.allow.json`. This exists because several
assertions here have asserted a *proxy* rather than the property —
`scrollWidth > clientWidth` for "scrollable", a formatted string for "the right
value" — and passed against deliberately broken code. It is a diagnostic, not a
gate, and not in CI: ~10 minutes for a full sweep. Details in DEVELOPERS.md →
Mutation check.

`npm run test:store` — renderer-store checks under plain node (~1s, no Docker,
no Electron). `scripts/store-race.mjs` bundles `mailStore.ts` with esbuild, stubs
`window.orbitMail`, and drives the exported actions, which is the only way to
reach renderer logic: the main-process suite must not import renderer code. It
covers the optimistic-UI invariants — a refresh landing mid-delete must not
resurrect the row, a rejected op must release the hold so the rollback restores
it, and the selection advances to the next row down. It also bundles
`RecipientInput.tsx` for the address-token math behind recipient autocomplete,
`src/utils/syncStatus.ts` for the status-bar wording that turns per-account sync
state into one line, `src/utils/search.ts` for which account(s) a query runs
against, `src/utils/ipcError.ts` for stripping Electron's channel wrapper off an
error before a toast shows it, `electron/services/connection-failure.ts` — a
*main-process* module, deliberately: it decides `needsReauth`, `syncStatus.ts`
consumes it, and the only honest test of that contract runs the real producer's
verdict through the real consumer — and
`src/utils/emailColorScheme.ts` for the dark-mode
contrast rule that decides whether a message renders on a light surface — the same trick works for any pure
renderer logic, which is why that classifier is string work and not a DOM walk.
Run it after touching `src/stores/`, any of those three, or the reader's
body rendering. Details in DEVELOPERS.md → Store tests.

The larger one is `npm run test:imap` — a growing suite of checks against a real GreenMail server in Docker, inside a windowless Electron main process (the DB needs `app.getPath`, and `better-sqlite3` is built for Electron's ABI). It covers the sync layer (STARTTLS, sync, UIDVALIDITY rebuild, IDLE reconnect, send, lane contention), the security controls (OAuth loopback `state`, credential handling, attachment classification), account-data hygiene (removal deletes AI tasks; freelist reclaim), the attachment text extraction the AI features depend on (OOXML, OpenDocument, RTF), and pure-logic invariants (launcher badge signal, zoom key matching, renderer-error log, IPC contract, docs-match-code). It runs in CI on every push. Run it locally after touching anything in `electron/services/`. Details in DEVELOPERS.md → Integration tests.

`npm run test:e2e` — end-to-end **through real windows**, the one thing
`test:imap` structurally cannot reach: it is windowless, so a `close` handler, the
draft flush and parent/child destroy order are invisible to it. Each suite imports
`electron/main.ts` whole and run in their own Electron process. **send** drives
`drafts.open` → the composer → a click on the real Send button → GreenMail, then
checks the draft is deleted, the message is in Sent, the recipient got it, and the
window closed without a save-as-draft prompt. Its draft carries an **attachment**
on purpose: approval is per compose session and the composer closes the moment
Send is clicked, so a held send used to reach `sendMail` with the user's own file
no longer approved — everything up to the click passed, and the message just
stayed in Drafts. **signature** types into a composer
and switches the From account across three accounts, checking the signature block
is swapped, removed and re-appended without eating what was typed. **format** drives
the toolbar's font and size selects in a real editor — `document.execCommand` *is*
the implementation, so there is nothing underneath to unit-test — and reopens the
draft afterwards, because inline styles have to survive DOMPurify on every load.
**window** maximizes
the composer and reads the bounds back — Electron's `isMaximizable()` says `true`
even when the WM has vetoed it, which it does for any window given a `parent` —
then closes the main window with a composer open and asserts the composer outlives
it and nothing throws. **zoom** sends real
`Ctrl` `=` / `_` / `-` / `0` keystrokes and reads `getZoomLevel()` back — the key
matching is pure and covered by `test:imap`, but whether the key reaches the
handler, whether the frame is actually zoomed, and whether the level survives a
reload need a window to send a key to. **undo** syncs a real message, clicks the
real Delete button and then the real **Undo** on the toast, and checks the
message is back **on the server** — the pure half is covered by `test:store` and
the Message-ID lookup by `test:imap`, but neither can render a toast, click its
button, or see where the mail actually ended up. **shortcuts** presses a real
`a` and checks a reply-all composer opens addressed to everyone on the thread
but us — asserting only that a window opened would prove nothing. **send-failure**
points the outgoing server at a closed port and reads the *toast in the main
window*: a held send runs on the scheduler long after the composer has gone, so
a failure used to reach only `console.warn` — the message stayed in Drafts and
nothing said so. **sent-copy-failure** is its mirror: the outgoing server is real
and the *incoming* one points at a closed port, so the message genuinely goes out
and only the APPEND that files the copy fails. It asserts the toast **leads with
the message having been sent** and never says "Not sent" — read the wrong way
round it costs the recipient a duplicate — and checks delivery against the
server, since that is what the toast promises. It caught a real defect on its
first run: the warning was a separate `app:toast` and the scheduler's own
"Message sent" overwrote it a tick later, so the user saw nothing. All twelve also
assert **nothing threw**. **snooze** moves a real message to the Snoozed folder
and asserts against the *server* that it left the inbox and came back when due —
the only thing snooze actually promises, and invisible from inside the app.
**scheduled-send** proves a timed message waits past the undo window and that
opening its draft takes it out of the queue. **reader-overflow** feeds the reader
hostile-width HTML and checks a sender cannot push the app's own controls
off-screen.
Needs Docker *and* a display (headless Ozone segfaults on the
first window), so it is **not in CI** — run it after touching the compose/send
path, signatures, zoom, message actions, keyboard shortcuts, or anything
window-lifecycle. Windows appear on screen for a few seconds.
Read the traps in DEVELOPERS.md → End-to-end first: the send suite has twice
passed while proving nothing, once from picking windows by index and once from a
composer that never loaded its draft. And two toasts about one event race: if a
check reads a toast, something else sending one is a bug in the *app*, not a
flake to sleep around. When you report a check, say which of the
five commands you ran.

**Do not treat `tsc -b` as a pass/fail gate.** The source does not cleanly pass a standalone `tsc -b` even on `main` (target/lib and third-party typing mismatches that esbuild transpiles past). Use `npm run build`.

**`npm run dev` fails here** (GPU sandbox crash), but that does *not* mean UI changes can only be checked by asking the user. Do the check yourself first, and only ask for what genuinely needs a human.

- **`npm run ui:preview`** — serves the built renderer to an ordinary browser with `window.orbitMail` stubbed (`npm run build` first; then `http://localhost:4321`). Drive it with whatever browser automation is available: click through, screenshot, **read the screenshot back** and actually look at it. This is how you verify layout, styling, both themes, and that a control renders and reacts. Details and the fixture trap in DEVELOPERS.md → Looking at the UI without Electron.
- **It proves nothing main-process.** Every IPC answer is a fixture, so a pane can look right while its channel is missing. That is `test:imap`'s job, not this one. Say which of the two you did.
- **Windowless main process** — `app.whenReady()` with no BrowserWindow, plus `app.disableHardwareAcceleration()` and `--no-sandbox`. Hosts the real DB layer, which is how `npm run test:imap` runs.
- **Hidden `BrowserWindow({ show: false })`** — renders real pages; used to verify CSP enforcement, console errors, and whether React mounted. Attach `out/preload/index.js` or the renderer errors on missing IPC.
- **`offscreen: true` hangs forever.** That is the thing that does not work, and what made "the GUI can't run" look absolute.
- **A *visible* window works on the real display** with `--disable-gpu` — that is what `npm run test:e2e` uses, and it is how anything window-lifecycle (a `close` handler, a parent/child destroy order) can be tested at all. Headless Ozone segfaults on the first window instead, which is why those checks cannot run in CI.

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

Notable schema facts (see DEVELOPERS.md for full rationale): `scheduled_actions` is work the app owes the future — a held send, a timed send, a snoozed message — persisted rather than kept in a timer because the app is not always running, and anything overdue runs at the next start; a row is deleted **before** its handler runs, because losing an action is recoverable and sending twice is not; Gmail labels are stored as one message row per folder, deduped by `message_id` at query time; `attachments.is_inline` marks an image mailparser already embedded in `body_html` as a `data:` URI (a signature logo) — the row is **marked, never dropped**, because `attachmentOccurrence` and `resolveAttachmentPart` identify a server part by counting position among same-named rows, so removing rows breaks fetching for exactly the messages where every part is `image001.png`; `has_attachments` means "some part is not inline"; `contacts` is a by-product of sync, not an address book — `harvestContacts` writes it from `upsertMessage` for new messages only (re-counting a re-sync would corrupt the ranking) and it is scoped per account by a cascading FK; threading is derived (`thread_id`) and always scoped by `(account_id, thread_id)`; AI results cache on the `messages` row (`ai_analysis`, `sweep_cache`) as partial columns so ordinary sync upserts leave them intact; there is **no** full-text index — search is a scope-aware `LIKE` over `messages`, and the old contentless `messages_fts` was removed (it was written on every sync and never queried); thread listing depends on two *expression* indexes on `COALESCE(thread_id, id)`, which `schema.ts` can only describe with `sql\`\`` — the `CREATE INDEX` statements in `index.ts` are what actually run; `pop3_skipped` remembers out-of-window POP3 messages by **UIDL** (message numbers are per-session and shift on delete) and stores each message's **date rather than a flag**, so widening `syncDays` brings it back into range with nothing to invalidate; `thread_analysis` caches a conversation summary under the **derived** thread key `COALESCE(thread_id, id)`, which only an account-level FK can protect — `regroupThreadsForAccount` can make that key stop existing, so orphans are pruned from inside regroup itself.

## The IPC contract is checked, not just documented

`npm run test:imap` parses `preload.ts` for `ipcRenderer.invoke('channel')` and
`main.ts` for `ipcMain.handle('channel')` and fails if any invoked channel has
no handler. This exists because a change once added two `oauth:` channels to the
preload but not to main: the build was clean, the suite was green, `tsc` was
unchanged, and the app failed at runtime with "No handler registered".

## Working conventions

- Branch from `main` per task; commit and open a PR/merge when asked (don't fuss over cosmetics).
- The renderer uses optimistic UI (read/star/flag/move/delete patch the list immediately and roll back on IPC failure — `patchMessageInList` in `mailStore.ts`). Preserve that pattern when adding message actions.

**Before committing**, in order — and **say which of these you ran and which you
did not**, because "verified" with no list has meant `build` alone more than once:

1. `npm run build` — always. It is the gate; nothing else substitutes for it.
2. `npm run test:store` — if you touched `src/stores/` or `RecipientInput.tsx`. ~1s.
   `npm run test:pure` and `npm run test:db` — if you touched a module either one
   covers. All three are about a second; running all three is cheaper than
   deciding which.
   Add `npm run test:mutants -- --file <the file>` when the change is to a pure
   module under `src/utils/`, to anything in `test:pure`, or to `db-service.ts`:
   it is the only thing that checks the new
   assertions would fail on the unfixed code, which is the part that has gone
   wrong most often here — twice more during the DB work, both times an
   assertion reading back a function's *argument* rather than what it stored.
3. `npm run test:imap` — if you touched `electron/`, the IPC contract, the schema,
   or any doc it checks. Also the honest default when you are unsure: it is what
   CI will run anyway, so finding out now is cheaper.
4. `npm run test:e2e` — if you touched the **compose or send path**, the
   **formatting toolbar**, **zoom**, or anything **window-lifecycle** (a `close`
   handler, a parent/child relationship,
   a `BrowserWindow` reference held across time, a `webContents` listener). This is the only check that drives
   real windows, and CI *cannot* run it — so if you skip it there, nothing catches
   it later. Needs a display and opens windows for a few seconds.
5. Docs in the same commit (rule 6), and grep for the claim you are replacing.

A new check earns its place here only if it fails on the unfixed code — every e2e
suite here was confirmed that way; see their TODO.md entries.

## Watching CI on a PR

**`gh pr checks` has no `--json` flag** in the `gh` on this machine — checked
against `gh pr checks --help` on 2.45.0, which lists only `--fail-fast`,
`--interval`, `--required`, `--watch` and `--web`. Other versions may differ, so
check the help rather than assume either way. Passing a flag it does not have is
not an error you will notice: the command prints nothing useful, and a poll loop
built on it spins forever.

That is not hypothetical. Two loops shaped like this were left running against
PRs #187 and #188:

```sh
# BROKEN — never terminates, and looks like "CI is still pending"
while true; do
  s=$(gh pr checks 187 --json name,bucket 2>/dev/null)      # always empty here
  jq -e 'all(.bucket!="pending")' <<<"$s" >/dev/null && break   # jq fails on empty
  sleep 30
done
```

`--json` is rejected, `2>/dev/null` hides the complaint, `s` is empty, `jq -e`
exits non-zero on empty input, and the `&& break` never fires. Both loops were
broken on their *first* iteration — before CI had even started — and the empty
output reads exactly like "no checks have settled yet". They had to be killed.

Use one of these instead:

- **`gh pr view <n> --json statusCheckRollup`** — `gh pr view` *does* take
  `--json` here. `.conclusion` is `SUCCESS`/`FAILURE`, `.state` covers pending.
- **`gh pr checks <n>`** with no flags, which is tab-separated
  `name<TAB>pass<TAB>duration<TAB>url`.

**And do not parse what you see on screen.** The `gh` output in this environment
is reformatted by the RTK proxy before it reaches you — `gh pr checks` arrives as
a rendered "CI Checks Summary" rather than the TSV above, so the text you read
and the text a script parses are different strings. `rtk proxy <cmd>` runs it
unfiltered when you need to know what a script will actually see.

Whichever you use: a wait loop must be able to end. Bound it with a maximum
number of iterations, so a wrong assumption about the command surfaces as a loop
that gave up rather than one nobody notices.
