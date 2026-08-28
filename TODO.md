# Orbit Mail — Work Log

**Outstanding work is at the top.** Everything already done is under
[Done](#done), with its reasoning kept — this file records decisions, not just
tasks, and the *why* behind a fix is usually the part worth having later.

Severity tags come from the [2026-07-21 audit](#security--correctness-audit-2026-07-21).

- [Outstanding](#outstanding)
- [Decided](#decided)
- [Done](#done)

# Outstanding

## Correctness and bugs

- **The blank-window root cause is still unknown.** Reported from a running app: white window, title bar still counting unread mail, and the renderer process alive at ~199MB — the signature of a render-time throw with no error boundary. The window is now recoverable and the error is written to `renderer-errors.log` (see Done), but *what* threw is not known, and nothing reproduced it: it appeared after the app was left idle, possibly across a desktop screen lock. Next occurrence should be diagnosable from the log; if it recurs without one, suspect the process dying rather than a throw. Worth noting the instance seen was `npm run dev`, so an HMR artifact is not ruled out — but a packaged app has the same missing boundary either way, which is why the fix was not made conditional on knowing.

- *(low)* **A long reply chain stores every copy of every embedded image.**
  Marking them inline (see Done) took them out of the attachment list, but
  `body_html` still holds one base64 copy per reply — 3.66MB for the thread that
  prompted the fix, 313MB of bodies across the profile. Deduplicating would mean
  rewriting bodies to a content-addressed store and resolving on render, which is
  a much larger change than the listing bug needed, and risks the "why did that
  image change" class of bug. Recorded because the disk cost is real, not because
  it is obviously worth paying to fix.
- *(low)* **`markRead`/`toggleStar` await the server round-trip inside the IPC handler** (`main.ts` `messages:markRead` et al). The renderer patches optimistically so the delay is not visible, but the handler stays open for the whole round-trip and a burst of actions serializes. Decoupling means a background queue plus a way to roll the UI back after the fact.
- **O365 Sent filing is unverified** (loose end from #32) — Exchange Online does not reliably file SMTP-submitted mail into Sent Items (it is governed by `MessageCopyForSMTPClientSubmissionEnabled`), so O365 accounts may not get a Sent copy at all. Left out of that fix rather than guessed at; needs testing against a real tenant.

## Performance

- Move sync + `better-sqlite3` + `simpleParser` off the main process (utility process / worker thread) — the largest jank/memory win, and the riskiest change.
- V8 code cache for the renderer bundle (fragile to wire in Electron; the vendor split already helps cache reuse).
- Window bounds still live in the DB, so window creation opens the DB (migration is cheap post-first-run, so not decoupled).
- **`listThreads` is still linear in account size** (partly fixed in #35) — the remaining ~35ms on a 3.3k-message profile is computing `MAX(date)` per thread across the account and sorting every thread before `LIMIT`/`OFFSET`. The expression indexes made that cheaper, not sub-linear, so a 100k-message account will still be slow. Fixing it properly means denormalising the thread key and last-activity date (a `thread_key` column, or a per-thread aggregate table maintained on upsert/delete), trading drift risk for an index-ordered page query. `countThreads` is now effectively free, so only the list query is worth the work.
- **Search is still linear in body size** (improved in #60) — `LIKE` cannot be indexed. A trigram FTS5 index over `search_text` would be the sub-linear next step; not taken, to avoid re-adding FTS machinery without separate justification.

## Features and polish

### AI

- **A very long conversation is still capped at 200 messages, with nothing said about it** — `getThread` now keeps the *newest* 200 (see Done), so the recent end is what you see and reply to, but a 260-message thread silently omits its first 60. Saying "showing the most recent 200 of 260" needs a total alongside the messages, which means changing what the channel returns — and pagination ("load earlier messages") wants that same shape. Worth doing together rather than twice.
- **Legacy and iWork attachments are still unreadable.** OpenDocument and RTF now ship (see Done). What remains: `.doc`/`.xls`/`.ppt` are OLE compound files needing a separate container parser *and*, for `.doc`, a piece-table walk to reassemble text — much larger than it looks; `.pages`/`.numbers`/`.key` are ZIPs whose payload is a binary protobuf variant, so the container opens and yields nothing useful. Encrypted documents are OLE wrappers around ciphertext and are out of scope. All are named in the panel, so the gap is visible rather than silent — which is the reason not to rush any of them.
- **Provider selection is still Anthropic-only.** Model and effort are now chosen in Settings → AI (see Done), but a non-Anthropic provider means a second SDK, a second key store, and prompts and structured-output schemas that survive the move — a different-sized job from picking a model.
- **Claude Haiku 4.5 is deliberately not in the model list.** It supports structured outputs, which every AI feature needs, but not `output_config.effort` — offering it means a per-model conditional around all four requests. Adding it later means adding that conditional with it; `test:imap` asserts no listed model rejects `effort`, so the omission cannot be undone by accident.
- Message-count / cost preview before an inbox sweep. (Sweeps are **incremental**: each message's extracted tasks are cached on its row, so a Sweep only sends messages it has never analyzed — a re-sweep of an unchanged inbox spends zero tokens. Reopening the Tasks dialog reads persisted results with no call. A one-time full pass over new mail is still billed, as is a **Re-analyze all**.)

### Elsewhere

- **Labels cannot be applied to a multi-selection, and cannot be renamed or
  deleted.** Both were scoped out of the label editor (see Done) rather than
  missed. The selection case is not hard — `relocateMany` is the shape to copy —
  but it needs its own answer to partial results across a hundred rows, which the
  conversation-sized "3 changed, 1 failed" toast is not. Rename and delete are a
  different size again: an IMAP `RENAME`/`DELETE` plus re-keying every local row
  that pointed at the old path, and the failure mode of getting it wrong is a
  label that exists on the server and nowhere in the app, or vice versa. Gmail's
  web UI does both well, and neither is what the feature was asked for.

- **That removing a label does not delete the message is untested against a real
  server.** It is Gmail behaviour — an expunge from a label folder unlabels,
  leaving the message in All Mail — and GreenMail has no such semantics, so
  `test:imap` covers everything *around* the round trip and not the round trip
  itself. Pointing a `gmail`-provider account at GreenMail does not work either:
  the pool authenticates Gmail with XOAUTH2. The honest options are a real
  account behind an opt-in env var, or a fake that would only assert what it was
  told to. Recorded rather than papered over.

- **Restoring down a composer that opened maximized gives a size nobody chose.** Size persistence ships (see Done); this is its one measured rough edge. A window maximized *before it is mapped* has no normal geometry for the window manager to restore to, so Muffin invents one at roughly 90% of the screen. The obvious fix is worse and was tried: re-imposing the remembered size from an `unmaximize` handler loses to the WM, which finishes its own restore afterwards and snaps the window back to the maximized rectangle — restore-down then appears to do nothing at all. The remaining option is to show the window unmaximized and maximize it after it is mapped, which trades this for a visible small→full-screen jump on **every** composer, a worse trade for a much more common action. Left alone deliberately; revisit only if a desktop is found where the jump does not happen.
- **IMAP draft upload** — local autosave ships (see Done); drafts are not uploaded to the account's Drafts folder, so one started here is not visible in webmail or on a phone. Uploading means an APPEND per save *and* deleting the previously uploaded copy or the folder fills with revisions, needs the connection lane, cannot work offline, and has no meaning for POP3. The duplicate-draft failure if a delete fails is the reason it was not done with the local half.
- Inline search-operator syntax (`from:`, `subject:`) and result highlighting — field **scoping** now ships via the search-scope selector (All/From/To/Subject/Body); inline operator parsing and match highlighting are still deferred
- Auto-update and code signing (CI and integration tests now exist — `.github/workflows/ci.yml` runs `npm run build`, `npm run test:store`, `npm run test:pure`, `npm run test:db` and `npm run test:imap` on every push and pull request; `test:e2e` cannot run there, and `test:mutants` is a diagnostic rather than a gate)
- Cross-platform builds (Windows/macOS)
- POP3 move support or reduced POP3 scope
- **Block is linear in account size** — `from_addr` stores the display form (`"Name" <addr>`), so the block predicate is a `LIKE` per blocked entry and cannot use an index; it is capped at 200 entries. The sub-linear fix is a `from_normalized` column populated in `upsertMessage` beside `search_text`, backfilled through `drainInBackground`, indexed on `(account_id, from_normalized)`. **Its trap, recorded before anyone tries it:** un-backfilled rows are `NULL`, and `from_normalized NOT IN (…)` evaluates to `NULL` for them — falsy — so a naive version silently hides *every* message the backfill has not reached yet. It needs `(from_normalized IS NULL OR from_normalized NOT IN (…))`, which in turn fails to block old mail until the backfill completes.

# Decided

## Bring-your-own OAuth credentials

Orbit Mail does **not** ship Google/Microsoft OAuth credentials, and will not.
Shipping them means either embedding the builder's own client secret in every
package — prohibited, see CLAUDE.md rule 5 — or registering a public client and
taking it through Google verification plus a CASA security assessment for the
restricted Gmail scope. **That cost has been declined** (2026-07-21), so the
bring-your-own model is the design, not a stopgap.

What that means for someone installing a build:

- They register their own OAuth app once (DEVELOPERS.md → OAuth setup), then
  either enter the credentials in the Add Account dialog (#46), put them in
  `~/.config/orbit-mail/.env`, or export them in the environment.
- They click through Google's "unverified app" warning per account, and the
  unverified user cap (100) applies to their own app — which is ample for a
  personal client.

The engineering side of this is finished: a packaged build is self-sufficient
and needs no file editing (#45, #46). What remains is inherent to the model,
not a defect.

## Full-text search, if it is ever wanted again

The old `messages_fts` table was removed in #36 (see [Done](#done)). Rebuilding it
means an *external-content* FTS5 table over `messages` (`content='messages'`,
joined on the implicit `rowid`), maintained by triggers: no duplicate text, and
deletes that work. It would change matching semantics — FTS matches whole tokens,
so searching `mail` would stop matching `gmail`, which today's substring `LIKE`
does. Preserving that needs prefix or trigram tokenisation.

# Done

## Shipped

- **`npm run test:db`, and mutation coverage for the database and the window
  geometry** — the answer to the limit the last round recorded: "anything
  touching the database, a socket or a window is still unmeasured. Narrowing the
  hole is not closing it."

  **The database was the hole.** `better-sqlite3` is a native module built
  against Electron's ABI, so nothing that imported the DB could be loaded by
  `node` — every database check lived in `test:imap` behind Docker and a
  windowless Electron process, ninety seconds a run. That is a fine gate and a
  useless measurement: a mutation sweep needs hundreds of runs.

  Node ships SQLite in its standard library now. `scripts/sqlite-node-shim.mjs`
  adapts that binding to the shape `better-sqlite3` presents, and esbuild swaps
  one for the other, along with the two pieces of `electron` the DB layer
  touches. Drizzle drives it unmodified. **The code under test is the code that
  ships** — the real `db-service.ts`, schema and migrations, in about a second.

  **Why a shim is allowed to be trusted here.** A shim is a second
  implementation and therefore somewhere for a difference to hide; a fast suite
  that lies about the driver that ships would be worse than none. So the
  assertions are not in the runner: they live in `scripts/db-contract.suite.ts`
  and *both* runners execute it — the shim under `test:db`, real
  `better-sqlite3` inside Electron at the end of `test:imap`. **It has already
  earned that.** An assertion that the new-mail notifier labels its message with
  the contract account's own address passed under `test:db` and failed under
  `test:imap`, where GreenMail's inbox holds newer mail and the notifier
  correctly named *that* account. The assertion was what was wrong.

  **The measurement.** First sweep over `db-service.ts`: **29 of 140 caught** —
  four fifths of the decisions in the file pinned by nothing at all. Four rounds
  of assertions later: **95 caught, 45 justified, 0 unjustified**, from 178
  assertions in the contract.

  **It found a real bug in the code, not only gaps in the tests.**
  `getAccountEmailCached` memoises the account address that contact harvesting
  needs to tell outgoing mail from incoming. Inverted, the memo returns nothing
  on every call and contact collection silently stops for the whole profile —
  with every existing check still green, because nothing asserted that a synced
  message becomes a contact suggestion. It does now.

  **And twice it caught assertions of mine that proved nothing** — the same
  mistake this tool exists for, made again while writing tests *for* the tool:
  `upsertFolder` returns the type it was *asked for* rather than the type it
  stored, so an assertion on its return value passes against a version that
  never writes; and "the account label is not the fallback string" passes when
  the broken `||` chain yields the display name, which is also not the fallback.
  Both read back through a second query now.

  **The rules had a one-sided hole.** They only ever *weakened* a boundary —
  `>=` to `>` — so a `>` that should have been `>=` could not be mutated into
  the bug it would be. `gt->gte` and `lt->lte` close it; `round->trunc` and
  `nullish->or` were added with them. Those four immediately found 17 unpinned
  decisions in renderer modules that had been at zero survivors, including
  another proxy assertion of mine: a percentage-channel rounding check written
  against 50% grey, where 127 and 128 sit on the *same* side of the classifier's
  boundary, so it passed whichever way the code rounded. It straddles the real
  boundary (112/113) now.

  `nullish->or` can also emit code that does not parse — JavaScript refuses
  `a ?? b || c` — which aborted a whole sweep partway through and reported
  nothing. Unbuildable candidates are counted and skipped, like the ones that
  compile identically.

  **The window half is smaller and honest about it.** `resolveComposeSize` was
  pure arithmetic living in `preferences-service.ts`, which imports the database;
  it moved to `electron/services/window-geometry.ts`. `zoom.ts` already imported
  only *types* from `electron`, so it bundles to a file requiring nothing. Both
  joined `test:pure` — 23 assertions moved out of `test:imap`, 15 added — and
  both sweep clean. What is *not* covered is anything needing a real window: a
  `close` handler, parent/child destroy order, whether the WM honoured a
  maximize. Those stay `test:e2e`-only, and no amount of extraction reaches them.

  **What is still unmeasured, stated plainly:** a socket and a window.
  `imap-sync.ts`, `smtp-send.ts`, the connection pool, and everything in
  `main.ts` that owns a `BrowserWindow`. That includes the three
  proxy-assertion mistakes that happened in `test:e2e`. The database is no
  longer on that list; the rest of it is unchanged.

- **`npm run test:e2e` exited 1 on a run in which everything passed.** Found by
  running it, not by it failing anything: all ten suites reported "0 failed"
  and then the runner threw `ReferenceError: selected is not defined` on its own
  summary line. `selected` was declared inside the `try` and counted after the
  `finally`, so the variable was out of scope exactly where the success message
  reads it — a shape that only shows up on the *passing* path, which is why the
  suite that introduced it (#186, "Let one e2e suite be run by name") looked
  fine. Hoisted out of the block.

- **`npm run test:pure`, and mutation coverage for the main process** — the
  second half of the testing work. The mutation check could only reach the
  renderer, because a sweep against `test:imap` (Docker, Electron, ~90s a run)
  would take hours.

  **Four modules import nothing at all** — `attachment-safety.ts`,
  `network-reachability.ts`, `sync-policy.ts`, `thread-util.ts`. They lived in
  the integration suite because there was nowhere else to put them. They now run
  under plain node in about a second, which makes them mutation-testable.
  Coverage **moved** rather than duplicated, and the arithmetic was checked
  across the move: 723 assertions before, 678 + 45 after. `test:imap` keeps what
  needs a server — that a refused connection reaches the *account* as "did not
  reach" is an integration fact; what counts as refused is arithmetic.

  **Two of the four had no direct coverage at all.** `sync-policy.ts` and
  `thread-util.ts` were exercised only through sync behaviour. `computeThreadId`
  decides which messages form a conversation and nothing asserted its precedence
  rules, its subject-key fallback, or that a word merely *starting* like "Re"
  is not treated as a prefix.

  **What the sweep then found in `network-reachability.ts`:** every existing
  case passed an `Error`, so the shape-extraction helpers were untested. A
  thrown string, a plain object with a `message`, an object carrying only a
  `code`, a number — all reach that classifier in the wild, and one mutation
  showed an unrecognised code would have been treated as an outage merely for
  existing.

  Whole set now: **125 mutants, 115 caught, 10 justified, 0 unjustified.**

  **Still unmeasured, and worth saying plainly:** anything touching the
  database, a socket or a window. That includes the three proxy-assertion
  mistakes that happened in `test:e2e` — the disabled-button click, the
  `scrollWidth` conflation, the dead auth guard. Narrowing the hole is not
  closing it.

- **`npm run test:mutants`, and the 32 gaps it found** — the answer to "you keep
  reporting tests that prove nothing; are the tests just bad?" Fair question, and
  adding another trap to CLAUDE.md was treating the symptom.

  **The measurement.** Change one token at a time in the pure renderer modules,
  run `test:store`, see whether it notices. First sweep: **106 mutants, 74
  caught, 32 survived** — 30% of the decisions in that code were pinned by no
  assertion at all. After the work: **98 of 107 caught, 0 unjustified.**

  **The recurring authoring error, named.** Every one of my bad assertions
  asserted a *proxy* rather than the property: `scrollWidth > clientWidth` for
  "scrollable", a formatted string for "the right value", `.click()` for "the
  user did it". Each holds when the property does not. The root cause of not
  *noticing* was that mutation testing was a habit I applied to whatever I had
  just written, when I remembered — and habits are what a codebase should not
  depend on. It is a command now.

  **It found a real bug, not only test gaps.** `fitPanes` returned panes summing
  to more than the window below ~200px, because both clamp bounds floored at
  `MIN_LIST_WIDTH`. Unreachable through the UI (the window's `minWidth` is 660)
  but wrong — and invisible to a property loop that started at a comfortable
  width, which is exactly the sort of blind spot a hand-picked test range has.

  **Twice, a survivor that looked obviously equivalent was not.** The reducer in
  `syncStatus.ts` needed accounts in *both* orders to pin it; my first fix for it
  did not discriminate and the tool said so. `and->or` on the same line was only
  equivalent under the orderings that happened to be tested. Both are now real
  assertions rather than allowlist entries — which is what the "write the reason"
  rule is for.

  Nine genuinely equivalent mutants are recorded with evidence: an sRGB knee at a
  channel value integers cannot produce, a four-digit hex alpha that can only be
  a multiple of 17, a guard whose fall-through returns the same answer anyway.

  **Deliberately not a CI gate.** ~10 minutes for a full sweep, and a slow check
  that fails for defensible reasons is one people learn to skip. A score is also
  not a grade — it rises just as easily by asserting more things as better ones.

- **A sender can no longer move this app's controls** — audit finding C3, which
  turned out to be two separate problems and not the one I filed.

  The filed symptom was a 19px overflow on the default fixture. That was gone by
  the time I looked, most likely absorbed by the responsive-layout work. The
  real defect was the one behind it: **nothing constrained message width at
  all**. `.pane-reader` has `overflow-y: auto`, which makes `overflow-x` compute
  to `auto`, so a wide table from a stranger's newsletter scrolled the *whole
  pane* and took the subject and the Reply buttons with it.

  Fixed at three levels — the body is its own horizontal scroll container, the
  pane sets `overflow-x: hidden` explicitly, and the reader header wraps. All
  three mutation-tested.

  **The second problem was ours, not a sender's.** The reader header holds six
  buttons and `flex-shrink: 0` made overflowing the only available outcome; at
  ~700px the app's own controls sat outside its own pane. Only visible now
  because C1 lets the window get that narrow. Found by a diagnostic that listed
  what was actually wider than the pane, rather than by assuming the message was
  to blame — the message wasn't.

  **A measurement trap, hit twice in one sitting:** `scrollWidth > clientWidth`
  says content is wider, not that anyone can scroll to it. With
  `overflow-x: hidden` the metric stays true while the content is clipped and
  unreachable. Both assertions here were written the wrong way round first and
  passed against deliberately broken CSS. Now in CLAUDE.md.

- **Scheduled send** — the last of B5's three, and the same scheduler with a
  time you chose instead of ten seconds. A time in the past is treated as "now",
  because the scheduler would run it on the next tick anyway and a countdown to
  nothing would be a lie.

  **The design decision worth recording:** a scheduled message waits in
  **Drafts** — the only place it is visible — and **opening it takes it out of
  the queue**. Without that second half, editing a message that is still going
  to send itself, unedited, at the old time is the worst outcome available.
  Both halves are mutation-tested: ignoring the chosen time, and leaving a draft
  queued when it is opened, each fail the assertions aimed at them.

  The e2e suite waits **past the ten-second undo window** before checking that
  nothing has gone, because a scheduled send that quietly used the hold instead
  of the chosen time would otherwise slip through. It also lets the scheduled
  time pass after unscheduling and checks nothing is sent — asserting only that
  the row vanished would not catch a send already handed to something else.

  **The suite caught a CSS mistake this repo had already made once**: I wrote
  `var(--bg-hover, …)`, a variable that has never existed, so the literal
  fallback would have shown instead of a themed colour. There is a comment
  elsewhere in the stylesheet about the same error, and a check that fails on
  it. Now `var(--hover-overlay)`.

  B5 is complete: undo send, snooze and scheduled send, all on one scheduler.

- **Snooze** — the second of B5's three, on the scheduler from the first. A
  message is **moved to a real `Snoozed` folder on the server**, not hidden
  behind a local flag: a snooze that only hid mail in this app would leave the
  inbox lying on your phone and in webmail, which is the opposite of the point.
  It also means someone who stops using Orbit finds their mail somewhere obvious.

  Keyed by **RFC Message-ID**, like undo and for the same reason — the local row
  does not survive the move. A message with no Message-ID cannot be snoozed at
  all and is reported rather than accepted and lost. If the folder it came from
  has been deleted by the time it wakes, it goes to the inbox rather than
  nowhere.

  **The folder is not called "Snoozed" on every server.** One that puts new
  mailboxes under the personal namespace creates `INBOX.Snoozed` — which is what
  GreenMail does. The app copes because it matches the leaf name; the e2e suite
  did not, and its first run reported an empty Snoozed folder for a message
  sitting in it. Worth knowing before writing any other check against a folder
  this app creates.

  **Presets land on a whole hour.** A message snoozed at 09:47 until tomorrow
  arrives at 08:00, not 09:47, or the inbox fills at times nobody chose. "Later
  today" disappears in the evening rather than quietly meaning tomorrow, and
  "this weekend" asked on a Saturday means the *next* Saturday — the rule that
  stops a preset firing in the past, mutation-tested across every day and five
  times of day.

  **CI caught a locale-dependent assertion**, and chasing it found two more from
  the list-header work that had been green since they were written. `12,000` is
  `12.000` in German and `2 Apr` is `Apr 2` in CI, so three checks were testing
  the machine rather than the code — one failed in CI, the other two would only
  ever have failed for a contributor abroad. All three now compare against the
  platform's own formatting, `test:store` passes under en_GB, en_US and de_DE,
  and the trap is written into CLAUDE.md.

  Remaining from B5: scheduled send, which is the same scheduler with a
  user-chosen time instead of ten seconds.

- **A scheduler, and undo send** — the first of B5's three features, and the
  foundation the other two run on. Undo send, scheduled send and snooze all
  need the same thing, so they share one table (`scheduled_actions`) and one
  ticker rather than three timers: the hard parts are surviving a quit and
  deciding what to do about something that fell due while the app was closed.

  **The honest bargain** is that a desktop client has no server-side scheduler,
  so nothing happens while the app is shut and anything overdue runs at the next
  start — late, but not lost. Persisted for exactly that reason; a `setTimeout`
  would lose a held send on quit.

  **A row is deleted before its handler runs.** A handler that throws halfway —
  an SMTP failure *after* the message reached the server — must not leave a row
  that sends it again on the next tick. Losing an action is recoverable by the
  user; sending twice is not. Mutation-tested by moving the delete after the
  handler, which fails two assertions.

  `compose:send` now *schedules* rather than sends: it keeps the draft (so Undo
  has something to reopen), holds for ten seconds, closes the composer, and
  tells the main window, which is where the offer has to live. `cancelSend`
  reports whether it won the race — an expired hold says "Too late" rather than
  claiming a recall that did not happen.

  **The send e2e suite had to learn about the hold**, and is better for it: it
  now asserts the message is *not* sent at once, which is the whole guarantee,
  before waiting for it to go. Without that it would have passed just as well
  against a build with no undo-send at all. It also exposed a real ordering
  detail worth knowing: the draft is deleted *before* the Sent sync runs, so
  the draft disappearing is not the signal that filing has finished.

  Not done: making the ten seconds a setting, which is what people eventually
  want from this. Scheduled send and snooze are next, on this scheduler.

- **The three panes adapt to the window** — audit finding C1. There were no
  media queries anywhere, and the sidebar and list were both `flex-shrink: 0`,
  so the reader was the only flexible pane and **absorbed every pixel the window
  lost**. `fitPanes` now decides the widths and a `ResizeObserver` applies them;
  the dragged widths are preferences, not promises. Space is reclaimed in the
  order a person would give it up — list, then sidebar, then sidebar entirely —
  with a toolbar toggle so a collapse is recoverable and deliberate-able.

  **Two things had to change for it to be worth anything, and both were found by
  the checks rather than by design.** `minWidth` was **900**, which made the
  collapse breakpoint unreachable — the code would never have run — and meant
  the app could not be snapped to half of a 1366-wide laptop screen at all. It
  is now 660: what two usable panes need (581) plus room for the toolbar. That
  exposed the second: **the toolbar overflowed**, and because it sits above the
  panes the *whole app* scrolled sideways while the panes below fitted
  perfectly. It now shrinks, with the search box as the shock absorber.

  **A correction to the audit itself:** C1 said the panes were "at fixed widths".
  They were already drag-resizable — what was missing was any response to the
  *window* changing size. The finding stands in substance; the wording did not.

  Still not done: the dragged widths are not persisted, so a resize is lost on
  restart. Related but separate, and not what C1 was about.

- **The list header says what you are looking at, and `a` replies to everyone** —
  audit findings C2 and B3, the last two "bites daily" items.

  **C2.** The header was four icon toggles and no words: no folder name, no
  count, no unread count. With "unread only" active the only cue was a button's
  pressed state, which is easy to leave on and then wonder where the mail went.
  The totals already existed in the store — they simply had nowhere to appear
  except the *"Load more (20 of 143)"* button, which is absent once a folder is
  fully loaded. `describeListHeader` is pure and covered by `test:store`.

  **A first attempt was wrong and the preview caught it.** The filter started as
  a separate "UNREAD ONLY" badge beside the count; at the list pane's real width
  (~320px) it was clipped to "UNREAD ON" by the toggles. Folding it into the noun
  — *"1 unread conversation"* — cannot be clipped, says the same thing in fewer
  words, and removed a rule rather than adding one.

  **B3.** Reply-all has always been a compose mode with a button in the reader;
  only the key was missing, on one of the most-used actions in work mail. `a` is
  now bound, and every reply/forward affordance names its key the way the Compose
  button already did.

  Covered by a new `e2e-shortcuts.suite.ts`, because whether a key *reaches* the
  handler cannot be answered without a window — the same reason the zoom suite
  exists. It asserts on the composer's actual To/Cc rather than on a window
  having opened: a reply-all that quietly addresses only the sender looks like it
  worked, and the people who needed the reply never see it. Mutation-verified by
  unbinding the key.

  Still unbound, and deliberately not done here: archive, star, mark-unread and
  `j`/`k`. Each is a decision about which key, not a one-liner, and B3 as filed
  was reply-all.

- **Undo for delete, archive and move** — audit finding B2. Nothing in the app
  was reversible, and `Delete` acts on a whole multi-selection, which is what
  made bulk triage feel risky rather than fast.

  **The mechanic that shaped the design:** a move does not preserve the local
  row. `relocateMany` moves the message on the server and then deletes the row;
  the next poll re-imports it under a new uid and a **new id**. So undo cannot
  hold the id it acted on — it keys on the RFC **Message-ID**, which survives and
  which `messages_message_id_idx` already indexes. `findMessagesByRfcId` returns
  every row for a Message-ID because Gmail keeps one per label: undoing an
  archive means finding the row *not* already in the folder being restored to.

  **What it refuses to do, deliberately.** Delete only expunges when the message
  is already in Trash, and an expunged message is gone — so it is skipped and the
  toast says how many cannot be brought back, rather than restoring four of five
  silently. Same for a message whose headers carry no Message-ID. When nothing
  qualifies, no Undo is offered at all rather than a button that does nothing.
  The offer is set **after** the server confirms, so a failed delete never
  presents one.

  Both honesty guards were mutation-tested: offering undo for expunged messages,
  and offering it when nothing can be restored, each fail the assertions aimed at
  them. `test:e2e` was run for this one — it does not exercise delete, but every
  suite loads `App.tsx`, so it catches the Toast change breaking the renderer.

  **That gap is now closed.** `e2e-undo.suite.ts` syncs a real message, clicks the
  real Delete button and then the real Undo on the toast, and asserts **against
  the server**: the message reaches Trash and leaves INBOX, then returns to INBOX
  and leaves Trash. Two mutations confirm it earns its place — removing the Undo
  button fails "the toast offers Undo", and a handler that reports success
  without moving anything fails all three restore assertions, which is the
  failure a local-state-only check would have missed.

  Its own first run is worth recording: selecting the row and clicking Delete in
  one evaluated block selected nothing, because React had not re-rendered and the
  toolbar button was still disabled — so the click was a silent no-op and the
  suite reported it as fine. The steps are now split with a wait between them.
  That is the third time in this repo an e2e check has passed while proving
  nothing.

- **The unified inbox is searchable** — audit item 2, and the biggest day-to-day
  friction in the app. "All Inboxes" is the view you land on and it was the one
  view whose search box was **disabled**, reading "Select a folder to search":
  `resolveSearchAccountId` returned null for the unified case, and the IPC method
  required an `accountId`, so cross-account search did not exist at any layer.

  `searchMessages` now takes `accountId: string | null`, where null means every
  account. It drops the `account_id` predicate rather than looping per account,
  so one `ORDER BY` and one `LIMIT` return the newest N *across* accounts rather
  than the newest N of each merged and re-truncated. The server-side fallback
  fans out concurrently with a per-account `catch`, so one unreachable server
  does not lose the others' matches.

  **The renderer needed a real type, not a nullable id.** "No account" used to
  mean both "search everything" and "nothing to search", and the ambiguity had
  been resolved the unhelpful way. `resolveSearchScope` returns `enabled`
  separately, so an unresolvable folder id — mid-load, or a stale preference —
  stays unsearchable instead of being silently promoted into a search across
  every account.

  **A problem unified search introduces:** nearly every account has a folder
  called "Inbox", so two results were indistinguishable. `searchFolderLabels`
  qualifies with the account (`Inbox · Work`) only when the results actually span
  accounts — qualifying a single-account search is noise the placeholder has
  already covered.

  Three mutations confirmed the checks discriminate, the important one being
  treating a falsy `accountId` as "everything": that would turn a caller passing
  `''` into a silent cross-account leak, and `test:imap` fails it.

- **Offline is derived from real connections, not `navigator.onLine`** — audit
  finding A5, and the other half of the per-account status work. Chromium sets
  `navigator.onLine` from whether a network *interface* exists, not whether
  anything is reachable over it, so a captive portal, a dropped VPN, a DNS
  outage or a server refusing connections all read as **online** and the app
  showed stale mail as though it were current.

  Each attempt now records `reachedServer` on its account. The distinction that
  matters is **refused versus never reached**: an expired token is not an outage
  — the server answered, it just said no — and calling it one sends you to debug
  a working network instead of your credentials. The bar gains a third state,
  "Can't reach your mail servers", for the case the old banner could never show.
  `navigator.onLine` is still consulted but trusted **only when it says no**.

  **Two bugs found by mutation-testing, not by reading.** The auth guard was
  dead code as first written — it only matters for a message that looks like
  both ("Login timeout: authentication failed"), and nothing in the pattern list
  matched a bare timeout, so it never fired. Chasing that turned up the real
  defect: the list matched only `socket timeout` and `connection timeout`, while
  imapflow and node-pop3 actually emit "Command failed: Timeout" and "Timed out
  while connecting" — so **every real timeout classified as reached** and the
  banner this feature exists for would never have appeared. Worth recording as
  the second time this session a plausible-looking check passed against
  deliberately broken code; the fix is always to find the input that
  discriminates rather than to trust the green.

- **Sync status is per account** — the first item out of the daily-driver audit,
  and the one four other findings collapse into. `SyncStatus` was a single
  global object: one `syncing` flag, one `lastSyncAt`, one `error` for every
  account at once. With more than one mailbox that shape cannot express the
  truth, and it produced three visible bugs — the sidebar could show **no**
  account health at all, one account failing **hid "last synced" for every
  account**, and two failures were joined with `\n\n` into a one-line status bar
  where HTML collapsed the break into a run-on sentence.

  The source of truth is now a per-account map; the aggregate fields are derived
  from it. A failure keeps its account's previous timestamp rather than stamping
  a fresh one (stale is not un-synced), a success lands its own verdict without
  waiting on a failing neighbour, and polling still swallows transient errors but
  no longer claims to have reached a mailbox it did not. The sidebar now marks a
  failing account, and the status bar names one failure or counts several,
  keeping the full per-account detail in the tooltip.

  **Verification is the part worth recording.** The "last synced" bug lived in a
  single JSX condition, which nothing in this repo could reach — `test:imap` is
  windowless and there is no component test. So the wording is now a pure
  function in `src/utils/syncStatus.ts` covered by `test:store`, which is the
  same trick already used for the dark-mode classifier. All three new checks were
  confirmed to fail on the unfixed behaviour: reinstating the suppression, the
  `\n\n` join, and unconditional timestamping each failed exactly the assertion
  aimed at it. The integration suite also caught a real bug mid-change — the new
  `accountLastSyncAt` key was not listed in `readRawState`, so the timestamps
  would have been silently dropped on every restart.

  Not done here, and deliberately: deriving offline state from real connection
  outcomes rather than `navigator.onLine`. It belongs with this work but is a
  separate change.

- **`npm ci` failed on a cold Electron cache, turning `main` red after the 44
  upgrade** — `scripts/install-electron.sh` printed "Installing Electron 44.0.0
  binary..." and exited 1 with no error. The cause is one line: `find` exits
  non-zero on a directory that does not exist, `set -euo pipefail` propagates
  that, and `set -e` killed the script before it reached the download. Guarded
  with `[[ -d ]]` and `|| true`, and both branches now say which one they took.

  **The bug predates the upgrade; only its reachability is new.** Up to Electron
  41 the directory always existed, because Electron's own postinstall created and
  populated it. Electron 42 removed that download — which is the same change
  already recorded as making this script load-bearing — so the first CI cache
  miss after the version bump hit a code path nothing had ever run.

  **How it got merged:** every local run had a warm `~/.cache/electron`, seeded by
  the `dist:deb` download during the upgrade trial. `npm ci`, `build`,
  `test:store`, `test:imap` and all five `test:e2e` suites passed on Electron 44
  and told us nothing, because none of them can reach a cold cache. GitHub Actions
  was in a `major_outage` for the whole window, so the one check that would have
  caught it never started, and the PR was merged on local evidence with the
  outage noted. Fixed by reproducing CI's exact state — empty `HOME`, no
  `node_modules/electron/dist` — where the old script exits 1 and the new one
  downloads and completes.

- **Audit sweep: the three findings Dependabot never raised** — `npm audit`
  reported high-severity DoS advisories in `brace-expansion` (unbounded
  expansion, and a second bypassing the first mitigation), `tar` (uncontrolled
  recursion on crafted long paths) and `nanoid` (custom generators looping on
  size zero). None appeared as Dependabot alerts, and all three are **dev
  toolchain, not the shipped app**: `brace-expansion` and `tar` come in under
  `electron-builder`, `nanoid` under `vite` → `postcss`.

  Every fix was already published **within the existing major line**
  (`brace-expansion` 1.1.18 / 2.1.4 / 5.0.9, `tar` 7.5.22, `nanoid` 3.3.18), so
  this is a lockfile refresh and nothing else — `package.json` is untouched and
  no parent package moved. Eight entries changed; `npm audit` now reports **0
  vulnerabilities**.

  Verified beyond the usual gates on purpose: `brace-expansion` and `tar` are on
  the **packaging** path, which no test exercises, so `dist:deb` was run to
  confirm electron-builder still packages after the bump. `build`, `test:store`
  and `test:imap` (665 passed, 0 failed) alongside it.

- **Electron 39 → 44** — clears the last open advisory, `extract-zip`'s
  unvalidated symlink path traversal, which reached us through Electron's own
  dependency. **`npm audit` names the wrong fix**: it reported
  `electron@44.0.0` because that is the `latest` tag, while the advisory's fixed
  range starts at **40.10.3**, where Electron swapped `extract-zip` for
  `@electron-internal/extract-zip`. So the minimum fix was one major, not five.
  44 was chosen anyway rather than 40 — this app renders untrusted HTML, and
  stopping four majors short on Chromium to shorten a changelog is the wrong
  trade. Runtime goes Chromium 142 → 152, Node 22 → 24, ICU 74 → 78; the `.deb`
  grows ~97 MB → ~107 MB.

  **No application code changed.** The 40–44 breaking-change list was checked
  against this codebase rather than inferred from a green suite: `clipboard`
  being removed from the renderer in 44 looked fatal but is not ours — the only
  hit is `event.clipboardData` in `RichTextEditor.tsx`, the DOM paste API.
  `showHiddenFiles`, `clearStorageData` quotas, `net.request` validation,
  frameless-window corners and the macOS/32-bit drops are unused or don't apply
  to a Linux x64 app.

  **Two deliberate acceptances.** Electron 43 changed unspecified dialog paths
  to default to Downloads rather than the OS-remembered directory; every
  `showSaveDialog` here passes an explicit `defaultPath`, but
  `compose:pickAttachments` and the save-all directory picker do not, so both
  now open at Downloads. Left as-is: it is a behaviour change, not a break, and
  worth watching before adding a `defaultPath` nobody asked for. Separately,
  `scripts/install-electron.sh` stopped being a workaround — from Electron 42
  the binary is no longer fetched by Electron's postinstall, so that script is
  now what puts it on disk, in CI too. Recorded in DEVELOPERS.md.

  Verified locally in full, because CI could not run: `build`, `test:store`,
  `test:imap` (665 passed, 0 failed) and `test:e2e` (**all 5 suites**, the one
  gate that actually exercises window lifecycle across a Chromium jump), plus
  `dist:deb` to prove it still packages and the native rebuild still works.
  `engines.node` for Electron 44 is `>= 22.12.0`, so INSTALL.md's "Node 20 or
  newer" was false the moment this landed and CI moved 22 → 24.

- **mailparser bumped to 3.9.16 to clear a high-severity parser vulnerability**
  — `deepmerge-ts` 7.1.5 is vulnerable to stack exhaustion on recursive objects,
  and it reaches us through `mailparser` → `html-to-text`, which is the code path
  that parses **untrusted mail**. Dependabot could not fix it in place: the patch
  is `deepmerge-ts` 8, so the whole chain has to move (`mailparser` 3.9.16 →
  `html-to-text` 10.0.1 → `deepmerge-ts` 8.0.2). It had raised a grouped branch
  for it that sat unmerged and was nearly deleted as a stale duplicate — worth
  reading the diff before clearing a `multi-` branch, because that is the shape
  the fix takes when it cannot be a one-line bump. Verified against the full
  suite rather than merged on green CI alone: the inline-image work in #168 keys
  directly off `simpleParser`'s `related`/`cid` fields and its `data:` URI
  rewrite, so a minor bump of that parser is exactly the change those assertions
  exist to catch. 665 passed, 0 failed.

- **Signature logos are no longer listed as attachments** — reported as a
  "proliferation of false attachments", with a screenshot of one message showing
  well over a hundred `image.png` chips. They were not false: mailparser puts
  every `multipart/related` part in `parsed.attachments` beside the real ones,
  *and* rewrites the `cid:` that referenced it into a `data:` URI in
  `parsed.html`, so we stored a row for an image the body was already showing.
  Down a reply chain that compounds — the worst message here held **182 rows, 15
  distinct images repeated about twelve times, 2.4MB**, with the two real
  documents lost among them; 10,110 of 10,868 attachment rows on that profile
  were images under 200KB.

  `isInlineImagePart` marks a part inline on the same conditions mailparser uses
  to embed it, so `image/svg+xml` — which its regex rejects, and which therefore
  never reaches the body — stays an attachment. Rows are **marked, not dropped**:
  part resolution counts position among same-named rows, so deleting them would
  break fetching for precisely the messages where everything is `image001.png`,
  and marking makes a wrong guess recoverable rather than destructive. The reader
  collapses them behind an "N embedded images" disclosure; `has_attachments` and
  **Save all** follow the same rule.

  History was backfilled rather than left to a resync, since 110 messages were
  already affected: mailparser's rewrite leaves each part's decoded size in the
  body as a `data:` URI, so `backfillInlineAttachments` matches on `mime:size`
  read from the base64 length. Two decisions worth keeping — matches are **not**
  consumed (one message holds 140 parts against 70 URIs, because Outlook keeps a
  part per quoted reply, and consuming would leave half the chips behind), and
  the candidate query does not filter on `body_html LIKE '%data:image%'` (that
  reads as a scan of every body; the loop filters for free on the body it fetches
  anyway). Matching the payload with a regex instead of walking it from JS took
  the pass from 14s to ~2.4s over 313MB of bodies. It marked 10,172 rows across
  516 messages; the worst went from 182 visible attachments to none, and the most
  any message still shows is 8 — all genuine documents.

  Not done, deliberately: **the bodies still hold every copy**. `body_html` for
  that thread is 3.66MB of repeated base64 and nothing deduplicates it. Only the
  listing was the complaint; the storage cost is recorded under Known limitations
  rather than fixed on spec.

- **`attachment-safety.ts` gained the cases its section was missing** — and the
  reason it happened is worth more than the tests. While writing the inline-image
  work above, `rg -n "attachment-safety" scripts/` returned nothing, so the
  existing section at `imap-integration.suite.ts:3182` was declared absent, the
  DEVELOPERS.md row describing it was deleted as a false claim, and a gap was
  filed that did not exist. All of that was published before anyone noticed the
  section was right there.

  **`scripts/imap-integration.suite.ts` contains a NUL byte** — an iWork fixture,
  `'\x00\x01binary'`, around line 3516. Searched as a named file, ripgrep reads
  it as text. Searched as part of a **directory**, ripgrep detects binary content
  and silently drops *every* result from the file, exit code 1, no warning. The
  suite is the repo's largest source of truth about what is tested, and it is
  invisible to the ordinary way of searching for things. Noted in CLAUDE.md.

  What was genuinely missing, and is now covered: `executableAttachmentWarning`
  had no assertions at all, so nothing checked that the dialog names the real
  extension — the entire point of the function, since a `.pdf.exe` is designed to
  be read as a PDF. Nor was `attachmentExtension`'s basename split covered, so a
  path-shaped filename was untested in both directions: `.../x.sh` must still
  warn, and `evil.exe/report.pdf` must not.

- **Gmail labels can be seen and edited on the open conversation** — asked for
  as "an easy and intuitive way to view existing labels and add/modify/remove
  labels". The implementation is small because the sync model had already made
  the decision: a Gmail label **is** an IMAP folder, and a labelled message is
  already stored as one row per label sharing a `message_id`. So the labels a
  message carries are the folders its copies sit in — the same relationship
  thread listing dedupes for display, read the other way — adding one is a
  server-side `COPY`, and removing one is an expunge of that copy, which on
  Gmail unlabels rather than deletes. No schema change and no new sync path.
  **Four decisions carry the feature.** *What counts as a label*: the Inbox and
  the user's own labels; not the virtual views, and not Sent/Drafts/Trash/Spam,
  which a message can only be *moved* to — "add the Trash label" would read as
  filing and behave as deleting. The Inbox is in on purpose, because removing it
  is how Gmail archives, and the chip's tooltip says exactly that rather than
  leaving it to be discovered. *What a change applies to*: the whole
  conversation, as in Gmail. *That partial is a real state*: a label on one reply
  of three is not the conversation being labelled, so the chip is dashed and the
  picker's tick is a dash — rounding it either way would state something false
  about the mailbox. *That the guard belongs in main*: `addLabel` and
  `removeLabel` refuse a non-Gmail account outright. The renderer also hides the
  row, but on plain IMAP a second copy is a second message, and the check that
  protects a mailbox has to be the one nearest the mailbox. **The copy source is
  deliberately non-virtual** — Gmail does not reliably allow a COPY out of
  `[Gmail]/All Mail`, so an ordinary folder is preferred wherever one holds the
  message. Thirteen checks in `test:imap`, and **one was passing for the wrong
  reason**: "another account holding the same Message-ID contributes nothing"
  survived deleting the account scoping from the SQL, because `listMessageLabels`
  drops foreign folders a step later anyway. It now asserts against
  `listMessageCopies` directly, where the leak would matter — `addLabel` reads
  those rows to choose the folder it copies *from*, and a copy taken from another
  account's mailbox is a copy from a server this one cannot reach. Both mutations
  (the scoping, the virtual-view filter) were confirmed to fail before being
  restored. Looked at in `ui:preview` in both themes, with a fixture that gives
  the conversation a partial label so the dashed chip and the dash-ticked
  checkbox are reachable at all, and one Gmail plus one plain-IMAP account so the
  row's absence is visible too. Two things left undone and recorded in
  Outstanding: labelling a multi-selection, and the Gmail server semantics that
  GreenMail cannot stand in for.

- **The same-account collision is qualified by parent path** — the case
  deliberately left out of the account-name change, and closed the same day it
  was filed. Two of one account's labels can share a leaf name (`Work/Receipts`
  and `Home/Receipts`), which Gmail's hierarchy makes easy to arrive at because
  `mb.name` is the **leaf**: the parent is nowhere in what the row shows. The
  account name cannot help there — it is the same word on both rows — so the
  parent path carries it, and a row that collides *both* ways gets both, joined:
  `Personal · Work`. **The delimiter problem the deferral was written around
  turned out not to exist.** It is per-server (`/` on Gmail, `.` elsewhere) and
  nothing stores it, but it does not have to be known: the leaf is the tail of
  its own path, so whatever single character precedes it *is* the delimiter.
  `folderParentPath` slices on that and is delimiter-agnostic, which the checks
  pin with a dot-delimited path alongside a slash-delimited one. **A name that
  is not the tail of its path yields no parent at all** — a localized `Bin`
  against `[Gmail]/Trash` — because slicing by length anyway prints a fragment
  of the path as though it were a parent. The rule moved out of the component
  into `favoriteRowHints` in `src/utils/folders.ts`, which made it plain data in
  and out, and therefore reachable from `test:store` — **and the first run
  failed two checks**: `slice(0, -1)` on a top-level folder returns the name
  minus its last character, so `Receipts` claimed a parent called `Receipt`.
  That is the argument for the checks existing: it is invisible by reading, and
  in the UI it would have shown a plausible-looking word that is not a folder.
  Twelve checks in `test:store`; looked at in `ui:preview` in both themes with a
  fixture carrying one of each collision and rows that collide with nothing.

- **An ambiguous Favourites row says which account it belongs to** — the item
  filed in Outstanding when the section was sorted, closed the same day it was
  written. The rule is the whole feature: the qualifier appears where a name is
  pinned by **more than one account**, not where a name simply repeats. That
  distinction is not pedantry — two `Receipts` labels inside *one* account would
  both be qualified "Personal", which looks like an answer and is not one, so
  that case is left unqualified and recorded in Outstanding instead. Names are
  compared case-insensitively, `receipts` and `Receipts` from two accounts being
  as confusable as two exact matches. Every other row is untouched, deliberately:
  qualifying all of them repeats one word down a list where the answer is usually
  obvious, and the per-account lists below already sit under a heading that has
  said it. The account name is the **short** form — `displayName` or, if that is
  blank, the address — which was already being computed inside
  `FolderContextMenu`; it moved to `src/utils/accounts.ts` rather than being
  copied, since a sidebar row and a context menu naming the same account
  differently is exactly the drift a duplicate invites. **Under squeeze both the
  name and the qualifier ellipsise**, which is a choice and not the default
  falling out: shrinking the qualifier away first would restore the very
  ambiguity it exists to resolve, so they shrink together and the row's `title`
  carries both in full. Looked at in `ui:preview` in both themes and with a long
  name and a long account name forced in, since the pair only competes for width
  when both are long. The fixture pins both Inboxes and nothing else colliding,
  so one list shows a qualified pair *and* unqualified rows — a fixture where
  every name collided would look right with the ambiguity test deleted.

- **Favourites are listed alphabetically too** — the follow-up to the sidebar
  sort, asked for immediately after it, and the one question worth asking first
  was whether `favoriteFolderIds` carried an order worth keeping. It does not:
  it is the order things were pinned in, `toggleFavoriteFolder` only appends,
  and nothing in the UI can reorder it — so there was no user arrangement to
  destroy, only an accident of when each star was clicked. Same comparator as
  the per-account lists, on `name`. Ties keep pin order, `sort` being stable,
  which matters here in a way it does not in the per-account lists: Favourites
  spans accounts and the row shows the name alone, so two pinned Inboxes are two
  identical rows. Sorting puts that pair adjacent — it does not cause it, but it
  does make it visible, so it is written up in Outstanding rather than left to
  be rediscovered. The section is also **reachable in `ui:preview` for the first
  time**: `favoriteFolderIds` was `[]` in the fixture, so a whole sidebar section
  had never been looked at there.

- **Gmail labels are listed alphabetically in the sidebar** — asked for after
  living with an account whose labels came out in server order, which for a
  Gmail account is neither alphabetical nor stable. Only the sidebar was
  affected: the move/copy menus already sort, through `foldersForAccount`. The
  sort is on `name` rather than `imapPath` because `name` is the leaf label the
  row actually shows — imapflow gives `mb.name` as the leaf and `mb.path` as the
  full hierarchy — so a nested label sorts where someone reading the sidebar
  would look for it, under its own initial, not its parent's. Standard folders
  are untouched: they render from `STANDARD_TYPES` in the canonical
  Inbox/Sent/Drafts order, which alphabetising would scramble for no gain. Only
  the `custom` list is sorted, and on a copy — `.filter` before `.sort`, since
  `accountFolders` is a memo result and sorting it in place would mutate cached
  state. Verified in `ui:preview`, whose folder fixture now lists four labels out
  of order (one lowercase, to show the ordering is the locale-aware one and not
  ASCII, which would file `accounts` after `Travel`).

- **Three settings were being silently discarded on every restart** — found while adding compose-window size persistence, because the same trap was about to swallow it. `readRawState` rebuilds the state as an **object literal**, so a key with no line in it is not merely left at its default: it is dropped on read, and the next `patchAppState` writes the blob back without it. `zoomLevel`, `aiDetail` and `alwaysIncludeAttachments` all went in without one. The effect on a user: **zoom did not survive a restart**, **"Always include attachments" turned itself back off**, and **Brief reverted to Full** — three features shipped in 0.6.0, each of which appeared to work, because within a session the cached state still holds the value and only a restart reveals it. Confirmed against the real preferences blob before touching anything: `zoomLevel` and `aiDetail` absent from disk entirely, `alwaysIncludeAttachments` present but re-defaulted to `false` on every write by the one line `patchAppState` does have for it. The comment on `PersistedAppState` has warned about exactly this since it was written, which is the argument for a check rather than a fourth careful reader: `test:imap` now fails if **any** optional key of the interface has no line in `readRawState`, *and* — separately, because a line that mentions a key and does the wrong thing with it would satisfy a shape check — writes a blob, drops the cache through the existing `resetPreferencesCacheForTests` seam, and reads it back. Both were confirmed by mutation: deleting the `zoomLevel` line fails the first with `dropped on read: zoomLevel`. Fixed in the same change as the feature rather than filed, because the fix is three lines in the function being edited and adding a fourth key beside three broken ones would have been indefensible.

- **The compose window remembers its size** — the follow-up recorded when the composer stopped being a child window, and the reason it was deferred rather than batched: the question was not how to store a number, it was **what to store**. Size only, and **no position**: every composer is a new window the WM is entitled to place, and pinning one to coordinates fights tiling desktops and strands the window off-screen when a monitor goes away. `maximized` is stored as its own flag because it is the actual complaint — someone who writes maximized wants the next message maximized, and remembering only the pixel size would reopen a screen-filling window that is *not* maximized, which is worse than either. It is stored with `getNormalBounds()` and not `getBounds()`, or restoring down on the next composer would do nothing visible. **The stored value is resolved rather than trusted**, because it outlives the display that produced it: a composer sized on a 4K monitor otherwise opens wider than the laptop it reopens on with its Send button past the edge, so it is clamped to the work area and up to the window's own minimums, and a non-number falls back rather than reaching the window — `NaN` fails every comparison, so a bare `Math.max`/`Math.min` passes it straight through to a window with `NaN` for a width. Nine checks in `test:imap` for the resolver and the wiring, two in `e2e-window.suite.ts` for the behaviour end to end (closed with `close()` and not `destroy()`, since the size is recorded in the `close` handler and destroy skips it — the honest limit of the feature). **One thing measured and then given up on**, recorded in Outstanding: restoring down a composer that opened maximized lands on a size Muffin invents, because a window maximized before it is mapped has no normal geometry to restore to. Re-imposing the remembered size from an `unmaximize` handler was written, tested and reverted — the WM finishes its own restore *after* it runs and snaps the window back to the maximized rectangle, making restore-down look broken rather than merely surprising. The e2e suite asserts a maximized composer reopens maximized and deliberately asserts **nothing** about restoring it down, which would only pin one window manager's invented number.

- **Font family and size in the compose toolbar** — asked for after checking what the toolbar had; the paragraph-style select's three heading levels were the only way to change size, and there was no typeface control at all. The work is not the two `<select>`s, it is that **`document.execCommand` cannot express either one directly**. `fontName` emits `<font face="…">` — the tag every guide to HTML mail says not to send — unless `styleWithCSS` is on, and that flag is document-wide and *sticky*: left on, **bold stops emitting `<b>`** and starts emitting `<span style="font-weight:bold">`, worse in exactly the old clients the change is for. So it goes on for the one call and straight back off, and the suite applies a font and *then* checks bold, which is the regression that mistake would cause. `fontSize` is worse: it speaks only HTML's legacy 1–7 scale, and even with `styleWithCSS` on it yields keyword sizes (`large`, `x-large`) rather than the value asked for — no mode of the command can say "24px". Size 7 is therefore used as a **marker**, keeping the part of `execCommand` worth keeping (splitting a selection correctly across element boundaries and partially-selected nodes) and rewriting the elements it tagged. **Two traps came with that and both are pinned rather than assumed**: pasted mail can contain a `<font size="7">` of its own, so pre-existing ones are recorded before the command runs and skipped after — resizing text the user never selected is a silent corruption of their message, not a cosmetic bug — and replacing the nodes collapses the selection, so it is restored across what was rewritten, or setting a size and then a font would mean reselecting in between. Children are **moved** rather than round-tripped through `innerHTML`, so an inline image or link in the selection survives as the same node. **A fifth e2e suite, and it had to be**: `execCommand` *is* the implementation, there is nothing underneath it to unit-test, and a stub would only have repeated the answer I hoped for — `test:store` has no DOM and `test:imap` is windowless and must not import renderer code. Twenty checks, driving the real `<select>` elements with real `mousedown`/`change` events because `onMouseDown` saves the selection and `onChange` applies it, and calling the handlers directly would not notice that pairing breaking. **The check that justifies the suite existing is the round trip**: the styling is inline `style=`, DOMPurify runs over the body on *every* load, and a stripped declaration would look like a working toolbar right up until the draft was reopened — so it flushes the draft, closes the composer, reopens it and looks again. Looked at in `ui:preview` in both themes and at the composer's 480px minimum, where the toolbar wraps to two rows on its own.

  **The selects were then made to follow the caret** (asked for before this went to a PR; it had been written up as deliberately-not-done, on the argument that a control claiming "Arial" while the caret sat in Georgia is worse than one that only offers — which is an argument for doing it *properly*, not for not doing it). Tracked from `selectionchange`, which is a **document**-level event with no element-level version, so the handler's containment check is load-bearing rather than tidy: the composer also has a subject field and a quoted-text block, and Settings mounts a second instance of the same editor. Read from `getComputedStyle` rather than `queryCommandValue`, which cannot answer for size at all — it speaks the same legacy 1–7 scale and has no idea what the px value is — and which gets inheritance right for free. **The e2e check earned its place immediately by failing**: `and back again` reported `font: "", size: "14"` for text that was visibly 24px Georgia, because a range that starts on an *element* boundary — which is exactly what selecting a paragraph's contents produces — has the paragraph as its `startContainer`, not the styled span inside it. It descends to `childNodes[startOffset]` now. Reading the code would not have found that; it looks right. Three smaller decisions: the empty option is deliberately **not** `disabled`, because a disabled option cannot be selected and a value landing on it would leave the control showing the previous font, which is the precise lie being avoided; choosing it back means "no change", not "no font"; and `emit()` re-syncs, because applying a command does not reliably move the selection, so `selectionchange` may not fire after one. A selection spanning several styles reports its **start**, which is what other clients do and is at least predictable. Sizes not on the menu (a heading at 20px, mail composed elsewhere) show empty rather than rounding to a neighbour and claiming the text is a size it is not.

- **The compose window could not be maximized, and nothing in the code looked wrong** — reported as "compose window should not be fixed size or position". The cause was one option: `parent: mainWindow`. Electron's `parent` sets the X11 `WM_TRANSIENT_FOR` hint, and to Muffin (Cinnamon) and Mutter (GNOME) a transient window is a **dialog**, whose maximize function the window manager clears outright — so `maximize()` was a silent no-op, no maximize button was drawn, and the window could not be tiled. **Electron reports none of this**: `isMaximizable()`, `isMovable()` and `isResizable()` all return `true`, because those flags are the app's and the veto is the WM's, which is why reading the code found nothing and why the fix was verified against a real window manager instead — two otherwise identical windows, one with `parent` and one without, and only the second one moved when maximized. Removing it makes the composer an ordinary top-level window. **The awkward part is what `parent` was also doing**: it was the deterministic reproduction of the `liveMainWindow()` bug, since closing the main window destroyed the composer and the child's `closed` handler then fired at a window that had gone. That ordering no longer exists, and a plain `mainWindow?.` would now pass the e2e suite — so the guard is deliberately kept on the strength of the *other* callers (sync and IDLE landing during teardown) and pinned by the source-shape checks in `test:imap`, which is a CI check where the e2e suite never was. Net loss of one reproduction, net gain of a check that runs on every push. Two behaviour changes fall out, both accepted: the composer no longer floats above the main window, and closing the main window **no longer destroys a half-written message** — which is the better default anyway, and is now asserted rather than merely tolerated. Three of the window suite's checks fail against the old code, the maximize one reporting `640x720 -> 640x720`. **Not done, and deliberately**: the composer still opens at 640x720 in whatever spot the WM picks. Persisting its bounds the way the main window's are persisted is a real want, but it is a different change with a different question behind it (does a reply reuse the size of the last composer, or does every message start fresh?), and it is recorded in Outstanding rather than smuggled in here.

- **A text-only analysis no longer passes for a complete one** — the last of the attachment ambiguities, and the one that needed data rather than judgement. The skipped-attachment caveat covered formats we could not read; nothing covered the user simply choosing "Text only", so a summary written from the covering note alone rendered identically to one that had read the agenda. `attachmentsIncluded` is now stored with the cached analysis — "ran without attachments" is a different claim from "there were none", and only the run knows which — with **absent meaning unknown**, so analyses cached before the flag say nothing rather than guess. **The trigger was the whole design problem, and the mailbox settled it**: 607 messages carry attachments and 161 of them (27%) carry nothing but small images, which an attachment row cannot distinguish from a screenshot because it stores no disposition. Firing on "has attachments" would have put a caveat under a quarter of all analyses for no reason. It fires on `isReadableDocument` instead — excluding images, and excluding formats we cannot open, since offering to include a `.doc` the extractor would skip anyway is a lie. A screenshot therefore never prompts: a miss rather than a false positive, which is the right direction for a nag. The classification moved to `shared/attachment-kinds.ts` because both processes must give the same answer — main decides what to extract, the renderer decides whether to mention what it did not — and drift would mean offering to include an unreadable file. Also shipped alongside: **Settings → AI → Always include attachments**, off by default, which collapses the split menu when on (a two-item menu whose answer is settled is just an extra click). Ten checks in `test:imap`; looked at in `ui:preview` with a message carrying a `.docx`, a legacy `.doc` and a logo, where the caveat correctly names only the `.docx`. That fixture also caught a stale one of my own: `Membership list.ods` had been standing in as an unreadable format since before OpenDocument support landed.

- **An attached email is read, one level deep** — the deferred item from the attachment-formats work, and the reason it was deferred rather than batched: the extraction is a dozen lines because `mailparser` was already a dependency, while the three questions around it each needed answering rather than defaulting. **It does not recurse** — an attached message can attach another, depth is chosen by whoever sent the mail, so following it is unbounded by construction and each level multiplies what one analysis costs; the nested message's own attachments are named and not read, the same bargain `skippedAttachments` already strikes. **Four headers, not the block** — From, To, Date, Subject; the rest is routing that costs tokens and helps no summary. **One fence, around the whole thing** — fencing the parts separately would mean writing our own labels *between* fenced regions from strings the sender controls, and a `From:` line the sender chose is no more trustworthy than the body under it. Sixteen checks in `test:imap`; the no-recursion bound and the header rule are both mutation-tested. **The header check had to be rewritten after the mutation passed**: naming two headers and matching them case-sensitively let `received:` and `x-mailer:` through, because mailparser lowercases keys — it is now an invariant over every line of the header block, which is the form that actually fails when the rule is broken.

- **Brief / Full summaries, chosen in Settings → AI** — the follow-up recorded when the summaries were expanded, and the reason it was worth splitting out: getting the fuller default right first meant the switch had something honest to switch between. Stored as `aiDetail` and resolved like model and effort. **It is a separate axis from effort on purpose** — effort buys *thinking*, detail buys *output*, and they are billed differently: a fuller summary costs output tokens whether or not the model thought hard to produce it, which is exactly why turning effort down was never the answer to "this is more than I wanted to read". Full is the default because it is what the app already did; a setting that silently shortened existing summaries on upgrade would be a change nobody asked for, dressed up as a preference. **Only the descriptions vary between the levels, never the shape** — `analysisSchema(detail)` rebuilds the same schema with a different `summary` description, so the parsed type, the cache and the renderer cannot tell them apart, and the suite asserts both levels produce identical field sets. Duplicating the schemas would have let them drift, and a field present at one level and absent at the other is a bug the type system would not catch. **Brief has the mirror image of full's risk**, and the prompt names it: shortening a summary by dropping the date out of it reads fine and is useless, so *"brevity is about leaving things out, never about being vague"*. The suite pins that both levels keep the anti-invention rule, the owner requirement and the carry-the-specifics rule — detail may change how much is said and nothing else. Thirteen new checks in `test:imap`; the pane was driven in `ui:preview` to confirm the control is wired, not just rendered.

- **Zoom, on the shortcuts a browser uses** — asked for, with the detail that made it worth doing carefully: *"CTRL- seems to be CTRL_ on my machine"*. Electron's default menu already carries Zoom In / Zoom Out / Actual Size, so the obvious implementation is to add menu items — and that would have reproduced the bug being reported. Those roles bind to the **accelerators** `CommandOrControl+Plus` and `CommandOrControl+-`, and an accelerator matches a *key*, not the character a layout puts on it: on a UK layout `Ctrl` with the `-` key can arrive as `_`, and `+` needs `Shift` at all, so neither fires reliably. `electron/zoom.ts` therefore matches on the produced character and accepts every spelling — `+ = Add`, `- _ Subtract`, `0 Insert` — via `before-input-event`, which sees the key before the page does. Three things that are not obvious from the request: zoom is re-applied on `did-finish-load` rather than only at window creation, because the level belongs to the loaded frame and resets on any reload — **including the reload that recovers a dead renderer**, which would otherwise silently undo the setting at the worst moment; every window shares one level, since a composer at a different size from the window that spawned it reads as a bug; and the print window is deliberately excluded, being a `BrowserWindow` whose zoom would change what comes out of the printer. Bounds are -3..+6 and a stored level is clamped on the way in, so a corrupted preferences blob cannot open the app at a size the user cannot read well enough to fix. Twenty-one checks in `test:imap` for the key matching and bounds, plus a **fourth `test:e2e` suite** driving real `sendInputEvent` keystrokes — the pure helpers were never the risky part; whether the key reaches the handler and the frame is actually zoomed needs a window to send a key to.

- **A blank window was unrecoverable and left no evidence** — reported with a screenshot: white content area, title bar still reading `Orbit Mail (37)`, so the main process was alive and syncing. `ps` at the time settled the mechanism: the renderer process was **alive** at ~199MB, so nothing had crashed. That is a render-time exception with no error boundary — React 18 unmounts the entire tree when a render throws, leaving an empty document in a live process, which is why the window was blank but the unread count kept moving. There was no way back except quitting, and no record anywhere: the stack was in a DevTools console belonging to a window the user cannot open. **The logging is the point of the fix, not a by-product** — this failure destroys its own evidence, so recovering the window without recording the cause would have guaranteed the next occurrence was equally unfixable. Now: an `ErrorBoundary` renders a panel with a **Reload** button instead of nothing; `render-process-gone` covers the *other* mechanism that produces an identical white window (the process actually dying, where every `mainWindow?.…` guard still passes because a live BrowserWindow with a dead renderer is neither null nor destroyed) and reloads, since main-window state lives in SQLite; and everything lands in `renderer-errors.log`, capped at 64KB by dropping **whole entries** — trimming by bytes cuts a stack in half, and half a stack reads as a different error. Three deliberate non-behaviours: the **composer is reported but never reloaded** (it holds text autosave has not taken yet, so a silent reload is worse than the blank window), `unresponsive` is logged rather than recovered (a long render recovers on its own), and `clean-exit` is not treated as a crash (that is a window closing normally). Errors in handlers, promises and timers never reach a boundary, so `main.tsx` reports those separately without raising the crash screen. Nineteen checks in `test:imap`, and the panel was looked at in `ui:preview` by making `App` throw — the first attempt at that proved nothing, because a one-shot throw is swallowed by StrictMode's double render. **The root cause of the reported incident is still unknown** and is recorded in Outstanding; what changed is that it is now survivable and, next time, diagnosable.

- **Summaries say more, and every action names who owes it** — asked for directly: more detail, and "actions for me to be identified". Two changes, and the second is the one that changes what the panel is for. The per-message list was plain strings under a prompt that said *"Only put things the USER needs to do in actionItems"*, so it was either the user's actions or empty — and empty is ambiguous exactly where it matters, because it cannot distinguish "nothing here is yours" from "the model found nothing". It also discarded what the *other* party had undertaken, which on a thread about a meeting is half the reason to read it. Both the message and thread analyses now emit `{action, owner}` from one shared schema, the reader lists the user's first and emphasises them, and the printed copy names owners too. Detail is set in the schema descriptions in sentences rather than token counts (three to six for a message, four to eight for a thread), plus explicit instructions to carry dates, amounts and names into the text rather than alluding to them, and to summarize attachment *contents* rather than noting that attachments exist. **The prompt draws the line the request implies but does not say**: more detail means saying more about what is there, never inventing more — without that, "be detailed" reads as licence to speculate, and a padded action list is worse than a short one because it can put a deadline in the user's head that nobody set. `test:imap` asserts both halves, so the constraint cannot be dropped while the instruction stays. **Cached analyses are upgraded rather than invalidated**: `normalizeCachedAnalysis` maps a legacy string to `{action, owner: 'You'}`, which is what those strings meant, given the prompt that produced them. Invalidating would have re-billed the user for work already paid for the moment they reopened a message; doing nothing would have rendered every cached row as an empty bullet. Ten checks in `test:imap`; both panels and both themes looked at in `ui:preview`, with the user's action deliberately placed *last* in the fixtures, since a fixture that already has it first proves nothing about the ordering.

- **More attachment formats, and the injection hole that adding them exposed** — OpenDocument (`.odt`/`.ods`/`.odp`), RTF, calendar invitations and contact cards (`.ics`/`.vcf` — a meeting invite says when the meeting is, which is exactly what Analyze is for), a handful of config and diff extensions, and HTML attachments now flattened with the existing `stripHtml` instead of being sent as markup. ODF reuses the ZIP reader unchanged; only the part name and tag vocabulary differ. RTF needed its own scanner because it is not a container — and because the parts that matter are the ones that are *not* text: strip control words naively and the document opens with "Times New Roman;Arial;" followed by the colour table, the same class of noise as OOXML's element-text numbers. **The security half was not on the list**: attachment text was never fenced. Message bodies have gone through `fenceUntrusted` since the injection work, but attachments — sender-controlled in exactly the same way, and a *better* hiding place because the user is less likely to have opened the document than to have read the message — were appended as bare blocks. Every format added widens that, so it is fixed here: attachment text is fenced, and the filename in the heading (which sits outside the fence, being a label we write) is stripped of newlines and marker lookalikes. **Two real bugs came out of testing rather than review**, both the same shape: `<c\b[^>]*(?:\/>|>…<\/c>)` reads as "either shape of a cell" but `[^>]*` eats the `/`, the `>` branch matches, and the lazy body runs to the *next* element's closing tag — so a self-closing empty cell takes its neighbour's value, and an empty `<text:p/>` swallows the paragraph after it. The `.xlsx` version of that shipped a week ago and no fixture had caught it, because fixtures written by hand do not contain the empty styled cells real spreadsheets are full of. Found because a first attempt at the ODF repeat-cap check passed under mutation — it was proving the trailing-empty trim, not the cap — and tightening it surfaced the merge. Twenty-five checks in `test:imap`; the fence, the repeat cap, the two cell regexes and the empty-paragraph case are each mutation-tested, and the empty-paragraph one had to be sharpened twice: asserting the text survived proved nothing, because merging keeps the text and loses only the line break.

- **"Include attachments" silently ignored every Office document** — reported, as "the analysis is telling me to read the doc rather than picking out actions *from* the doc". It was not a broken feature so much as an invisible one: `buildAttachmentBlocks` handled images, PDFs and text-like files, and a `.docx` matched none of the three, so both attachments on a meeting agenda went straight to `skipped`, `blocks.length` was zero, and the guard on it left the prompt body-only. The model then did exactly what it should with a body that says "agenda attached" — told the user to read the agenda. **The obvious fix is not available**: the API takes PDF or plain text in a `document` block and nothing else, so the compression is not the obstacle — the bytes never reach a decompressor, and there is no header that makes Word acceptable. The two real options were converting locally or uploading the file for the code-execution sandbox to open with `python-docx`; the sandbox route was rejected because it sends users' attachments to Anthropic wholesale, against what README promises about when mail leaves the machine. `office-text.ts` therefore unzips `.docx`/`.xlsx`/`.pptx` in-process (`zlib.inflateRawSync` plus a central-directory reader — no dependency added). **Text is taken from run elements only**, which was not the first attempt: stripping tags across the part is shorter and works on every fixture, then prefixed a real agenda with `34817056216650` — a floating image's coordinates, stored as element text. Fixtures cannot find that, and it was only caught by running the extractor against the actual attachment that prompted the report; the regression is now in the suite as its own check. **The second half is that the failure was undetectable**: a body-only answer renders identically to a complete one, and the only signal was a toast that had already gone. `skippedAttachments` is now cached with the analysis and rendered under it, so the caveat survives reopening the message and names the files — which matters more than the format support, because the list of formats we cannot read (`.doc`, `.odt`, encrypted, ZIP64) is never going to be empty. Seventeen checks in `test:imap`; verified in `ui:preview` in both themes, and against the two real `.docx` files from the reported message.

- **Nine hover states and one shadow referenced undefined CSS variables** — the follow-up to the composer dark-mode fix, which had found four undefined variables and fixed only the two that made text unreadable. The other two failed more quietly: `var(--bg-hover)` and `var(--shadow-md)` have no fallback, so the declaration is invalid at computed-value time and the property falls back to its initial value — the hovers did nothing at all, which is indistinguishable from a design choice and so was never reported. Resolved against the existing convention rather than by inventing values: `--hover-overlay` for the six controls and nav items (matching `.sidebar-item`, `.settings-nav-item`), `--bg-list-hover` for the two solid subtle surfaces (the attachment chip and inline `code`, neither of which is a hover), `--shadow-soft` for the account menu, and `--accent-soft` for `.search-server-btn:hover` — that one had a literal `rgba(43, 125, 233, 0.1)` fallback that *did* render, an off-palette blue that never followed the theme, so it was the one site with visible-but-wrong behaviour rather than none. **Now checked**: `test:imap` asserts every `var()` resolves and every themed variable is restated for dark, both mutation-tested. Comments are stripped before the scan, since the fix commits describe the old broken names in prose and a naive scan fails on its own documentation.

- **The `desktopName` build warning is gone** — it fired on every `dist` run and had been left alone deliberately, on the finding that window association already worked on X11 and that acting on the warning naively would break it. Both halves of that finding held up; what had been missed is that they are not in conflict. `desktopName` is **top-level package.json metadata**, not a `build.linux` option (putting it under `linux` fails electron-builder's schema, which is the first thing anyone tries), and although electron-builder derives `StartupWMClass` from it, `LinuxTargetHelper` applies `linux.desktop.entry` *last* in its `deepAssign` — so an explicit `StartupWMClass` still wins. Setting `desktopName: "orbit-mail.desktop"` plus `syncDesktopName: true`, and keeping the explicit `StartupWMClass: "Orbit Mail"`, silences the warning and produces a `.desktop` entry **byte-for-byte identical to the published 0.5.4 `.deb`** — verified by diffing against the downloaded artifact, not by reading the config. Four new checks in `test:imap`, two of them mutation-tested: dropping the explicit `StartupWMClass` (what the warning's own docs suggest) and renaming `desktopName` away from the hardcoded `LINUX_DESKTOP_ENTRY_ID` both fail. Native Wayland is still untested — see Outstanding; this changes nothing there, since Electron's `app_id` comes from the `app.setDesktopName` call that was already in place.

- **The quoted original in a reply was unreadable in dark mode** — the other half of the reader fix above, and predicted by it rather than reported. The composer shows the same sender HTML, sanitized the same way, so it had the same problem: an inline `color:#1a1a1a` on a dark composer. Reuses the reader's classifier, but decides **once, when the quote arrives**, not from the live edited value — it is a fact about the mail being replied to, and recomputing per keystroke would also let the block flip colour mid-edit as the user trims the coloured part away. The paper class sits on the contenteditable element itself, so it is not part of `innerHTML` and cannot travel out with the reply (verified in `ui:preview`, not assumed). Drafts were already safe: they store `quotedHtml` separately from `bodyHtml`, so a reopened draft puts the quote back in the quote block rather than into the editor.
- **The composer's formatting toolbar was a white bar in dark mode** — found while looking at the quote fix, and the same class of bug from a different cause. `.rte-toolbar` asked for `var(--bg-primary, var(--bg-list, #fff))` and `.compose-drop-overlay` for `var(--bg-primary, #fff)`; **neither variable has ever existed in either theme**, so both fell through to the literal `#fff`. That was right by accident in light mode and wrong in dark, leaving `--text-secondary` icons on white at about 2:1. Both now use `--bg-main`, which is `#ffffff` in light mode — so the light theme is unchanged by construction, not just by inspection. Two more undefined variables turned up in the same sweep and were left alone; see Outstanding.
- **`ui:preview` could not reach the compose window at all** — `#/compose` renders an empty "New Message" until `compose.onOpen` fires, and the stub returned a no-op unsubscribe for every `on*` method, so there was nothing to look at. Subscribers can now carry one payload; the compose one is a reply quoting the thread fixture's first message. This is why the toolbar bug had gone unnoticed: nobody could see that pane without building and running Electron.

- **Dark mode showed unreadable text in HTML mail** — reported. The cause is a side effect of a security control: the sanitizer forbids `<style>`, so a sender's colours can only arrive as inline `style`/`bgcolor`/`color=` attributes — and inline styles beat our stylesheet, so `.reader-body`'s theme colours lose and the message is painted for a canvas it is not on. Both directions were reproduced in `ui:preview` before any code changed: dark text with no background on our dark grey, and our own light text on the sender's white table. **Chose a light surface over rewriting the colours** (`src/utils/emailColorScheme.ts` + `.email-html-paper`): rewriting means guessing which foreground pairs with which background, and getting that pair wrong reproduces the same bug, whereas a light surface is correct by construction because it is the canvas the sender assumed. The tradeoff was put to the user explicitly and accepted — most HTML mail sets some colour, so most HTML mail now renders on a white card in dark mode. Thresholds are derived from the theme's own `--bg-main` and `--text-primary` at 4.5:1 rather than picked, so the rule is "would this actually be unreadable here". Nineteen checks in `test:store`; two mutation tests confirmed the `background-color`/`bgcolor` substring traps are really guarded — the first attempt at the `bgcolor` check passed for the wrong reason (the light-background path flagged it regardless) and was replaced with a dark `bgcolor`, which discriminates.

- **New-mail notifications fired twice for one arrival** — reported, not found by a test. Two paths announce new mail and neither knew about the other: the IDLE push handler, and the safety-net poll that runs every 90s for IDLE-capable accounts with `announce` defaulting true. One arrival reaches both whenever the poll's estimate is taken before IDLE has stored the message. **The guard in place was a five-second wall clock, which is a rate limit and not a dedupe** — it collapsed the duplicates that happened to land close together and let through the ones that did not, and since the poll's pass takes seconds the second announcement usually fell outside the window, which is why the symptom looked intermittent rather than constant. The underlying gap was that `getLatestInboxMessage` returned no id, so the notifier could not tell it was repeating itself: the only question it could ask was "was I noisy recently", never "have I already said this". Now decided in `electron/services/new-mail-notice.ts` on the message id, with the rate limit kept only for genuinely distinct arrivals; the policy moved out of `main.ts` so it can be tested without a display or a mocked Electron `Notification`. Two of the seven new checks fail against the old behaviour, reporting `announced "Lunch?" twice`.

- **The thread reader was replying to the wrong message on long conversations** — `getThread` ordered ascending and limited, keeping the *oldest* 200, and the reader takes `messages[length - 1]` as "the latest", which is what Reply, Reply All, Forward and Draft reply all target. So on a long thread the reply went out against a mid-thread message: threaded under the wrong parent, and **reply-all addressed to that old message's recipients** rather than the current ones — people added since silently dropped, people removed re-added. Mail to the wrong humans, not a display quirk, which is why this was worth doing ahead of pagination. The dedupe also ran after the limit in JS, so Gmail's per-label copies spent the budget; with two labels a 250-message thread returned **100** distinct messages and treated `<r99>` as the newest. Both fixed the same way `listThreadMessages` was: choose in a `date DESC` subquery, dedupe with `GROUP BY COALESCE(message_id, id)` so the limit counts distinct messages, restore reading order outside. Four of the seven new checks fail against the previous implementation, including the reply target. Found while writing up the thread-summary work, not by anyone hitting it — which is its own point: nothing in the app surfaces a truncated conversation.

- **Conversation-level AI: summarize a whole thread** — AI worked at two scopes, one message or a folder sweep, so a twenty-message thread where the decision landed in message fourteen could only be read one message at a time. `analyzeThread` returns a summary, the decisions actually reached, action items **with an owner**, and unanswered questions, cached in a new `thread_analysis` table. **The window is the opener plus the most recent eleven, not the last twelve**: the opening message is usually the only place the original request appears, and the tail is where the thread stands — and when anything is left out, both the prompt and the panel say so, because a partial summary that reads as a whole one is worse than no summary. **Staleness is labelled, never auto-resolved**: a reply arriving marks the summary stale and it is still shown, rather than dropped or silently regenerated — regenerating on open would spend the user's money every time they reopened a busy thread, the same argument that made **Re-analyze all** an explicit button. **Orphans are pruned, not adopted**: a thread key is derived, so `regroupThreadsForAccount` can make one stop existing when a late reply bridges two conversations; the prune runs from inside regroup (in a `finally`, so the empty-account early return still runs it) and deletes rather than migrating, because after a merge the surviving conversation is a different, larger one that the old summary was never about. Two bugs the tests caught rather than review: the staleness fingerprint keyed on **row id**, so adding a Gmail label made a message look newer and flipped an unchanged summary to stale — it keys on Message-ID now, as the count already did; and an assertion of mine passed for the wrong reason (`Subject w1` is a substring of `Subject w19`, which was *in* the window). 32 new checks, none of which need an API key: the cache, staleness, orphan pruning, the cascade, and the prompt's fencing, caps and windowing.

- **The pooled IMAP connection is held for five minutes, with a staleness probe** — the entry said *measure before tuning*, so: a cold open costs **~130ms against loopback with no TLS** versus ~1ms warm. That is the floor, not the number a user sees — a real server adds TCP, TLS and auth round trips, and Gmail adds a token refresh on an expired token — so at the old 30s any interaction after a half-minute pause paid it. **Raising the idle window alone would have been the wrong trade**, and reading `withImapClient` is what showed why: a connection can die with neither end noticing (a NAT dropping it without a FIN leaves `usable === true` and a socket that answers nothing), the operation then hangs until imapflow's 300s socket timeout, and the error lands on whatever the user just clicked — no retry. Longer idle, likelier that. So the probe shipped with it: a client idle beyond 60s is checked with a NOOP, bounded at 3s, and replaced if it does not answer. **Deliberately a probe and not a retry** — half of what goes through this pool is a mutation, and re-running a move or append that had in fact reached the server would apply it twice; a NOOP is idempotent, an arbitrary retry is not. Two defects found while building the test, both of which would have made things *worse* than the status quo: `closeLaneClient`'s polite `logout()` is unbounded and hung for 300s on the dead socket it was cleaning up after (now raced against a 2s timer, then `close()`); and the idle comparison was `>`, which skipped the probe whenever two operations landed in the same millisecond — visible as a check failing one run in three, hanging the full 300s on the operation the probe exists to protect (now `>=`). Tested with a TCP proxy that stops forwarding on an established connection while holding both sockets open, since a half-open socket cannot be simulated by closing anything; four consecutive runs at ~3.24s each, where the pre-fix behaviour was a 300s hang.

- **POP3 sync was throwing `ReferenceError` on every poll, for a week** — `pop3-sync.ts` called `getFolderServerUidSet` without importing it, from `f19c3b2` (23 July) onwards, so `syncPop3Account` *and* `estimatePop3NewMessageCount` threw immediately: POP3 accounts synced nothing at all, through both 0.5.0 and 0.5.1. Three things had to line up for that to ship unnoticed: esbuild transpiles without type-checking, `tsc -b` is deliberately not a gate here (it does not pass cleanly on `main` for unrelated reasons), and the suite's only POP3 coverage was a client-timeout check against a socket that never speaks — nothing ever called the sync. Found while writing a test for something else, which is the argument for the test rather than for the fix: the fix is one import line. The new section's first two assertions are simply that each function runs to completion, because that is what nothing asserted.

- **An out-of-window POP3 message is read once, not on every poll** — a message older than the sync window is never stored, so nothing in `messages` recorded that it had been examined and each 20s poll re-read its headers, forever. `pop3_skipped` now remembers it by **UIDL** — message numbers are per-session and shift whenever anything is deleted, so a high-water mark over them would drift onto the wrong messages — and stores **the message's own date rather than a skipped flag**, so widening `syncDays` brings it back into range by itself. A flag would have needed clearing whenever the window changed, and the version that forgot would silently never fetch old mail again. Pruning runs against the **full** UIDL listing rather than the batch: against the batch it would forget everything older than the last `SYNC_BATCH_SIZE` messages every poll and re-read it all on the next, which is the cost this removes; with no pruning at all the table would grow for the life of the account as mail is deleted server-side. The backstop path records too, so a server without `TOP` stops re-downloading whole messages. Verified by a hand-rolled POP3 server in the suite that **counts commands** — the claim is "the second poll asks the server nothing", and only command counts can show that: `TOP x1 RETR x0` after two polls.

- **Changing the From account now swaps the signature** — the signature is wrapped in `div.orbit-signature` (`SIGNATURE_CLASS` in `shared/signature.ts`, shared because main writes it, the composer looks for it and the suite asserts it), which is what makes it findable at all: unmarked, it is indistinguishable from anything else typed, and switching accounts could only leave the previous account's signature in place. Gmail marks it the same way. The composer fetches the new signature through a new `accounts:getSignature` channel — `getInfo` already carries the signature, but computes message counts, attachment stats and on-disk size to do it, which is absurd for a select change — and then edits the **live DOM** rather than going through state: the body editor is uncontrolled, so a re-render means remounting it and discarding everything typed. Three cases, all reachable: swap the block's contents, remove the block when the new account has none, append one when there is no block. **Two real defects on the way, both found by the new e2e suite and neither visible to anything else:** (1) making the block own its `<br><br>` separator — which reads as tidier, one node owning the insertion — put the block *first* in an otherwise empty body, so focusing the editor placed the caret **inside the signature**; the user typed into their own signature and the next From switch replaced the block and took the message with it. Data loss, from a change that looked like a cleanup. The separator stays outside, as Gmail nests it. (2) With it outside, removing the block left the blank line behind and re-appending added another, so switching From repeatedly grew a stack of them — hence `dropSeparatorBefore`. Both are now assertions. A signature the user has edited is still replaced, which is what swapping means and what other clients do; the settings pane says so instead of implying edits are preserved, and its old copy stating the limitation is gone.

- **The copy filed in Sent now records who was blind-copied** (the loose end from #32) — Bcc pulls in two directions and a single build could only satisfy one: the transmitted message must not carry a `Bcc` header, because the envelope is what routes mail and a header discloses those recipients to everyone else on the message, while the filed copy must carry it or the sender cannot tell afterwards who they blind-copied. nodemailer strips Bcc while building; `keepBcc` on the compiled MimeNode is the mechanism its own stream/JSON transports use, so the filed copy is a second build with that set — taken **only when a Bcc exists**, since otherwise the two builds differ in nothing but MIME boundaries and every attachment gets composed twice for nothing. The `messageId` is now pinned by us (`<uuid@from-domain>`) instead of nodemailer minting one per compile: two builds with two Message-IDs would thread separately and defeat the label dedupe, which keys on `message_id`. **The test was the interesting part.** The existing check asserted "Bcc is not in the headers" against the *filed* copy, which was only ever a proxy for the transmitted bytes — they were the same bytes — and after this change would have failed for the right reason while saying the wrong thing. It now reads the **delivered** copy for the privacy property, which is what the property is actually about, and a second check reads the filed copy for the record-keeping one. Confirmed by stashing only the source change and re-running: the filed-copy check failed and the delivered-copy check still passed, so the pair discriminates rather than just being green. Applies to what Orbit Mail files, i.e. manual IMAP accounts — Gmail files its own copy, and O365 remains unverified above.

- **The destroyed-window bug has a real regression check, and the e2e command covers more than send** — `test:send-e2e` became `test:e2e`, running two suites in separate Electron processes, because `e2e-window.suite.ts` **has to** be its own process: it ends with every window destroyed, and closing the last window quits the app. It holds one hidden window of its own open so the process survives long enough to report at all. What it reproduces is the `liveMainWindow()` bug: close the main window with a composer open (`closeToTray` off, which is also how a tray-less desktop behaves), and the composer — a *child* — is destroyed with its parent, whose `closed` handler then calls `notifyMessagesUpdated()` at a window that has gone. Confirmed both ways against a bundle with the fix mutated out: reverted exits 7 naming the throw, current exits 0 with 6 passes. **A throw is reported the moment it is caught rather than at the end**, which was not the first design: the regression derails the close it happens in and takes the process down with a second throw before any summary prints, so the original version reported a real failure as three passes followed by a stack trace — legible to nobody. Needs no mail server, unlike the send suite; the runner starts GreenMail anyway because the two share a command. The shape it is *not*: asserting `mainWindow === null`, because neither nulling on `closed` (the child's handler runs first) nor `window.isDestroyed()` alone (the webContents dies first) is what actually fixes it — so the assertion is "does anything throw".

- **The send path has an end-to-end check through real windows** (shipped as `npm run test:send-e2e`; renamed to `npm run test:e2e` when the window-lifecycle suite joined it — see the entry above) — kept from the throwaway harness that verified the send fix and then found the destroyed-window bug, because both of those came from the one area `test:imap` structurally cannot reach: it is windowless, so a compose window's `close` handler, the draft flush, and parent/child destroy order are invisible to it. The harness imports `electron/main.ts` **whole** rather than re-implementing handlers — a re-implementation would have "passed" against the very wiring that was broken — and drives `drafts.open` → composer → a click on the real Send button → GreenMail, then checks the draft row is gone, the message is in Sent, the recipient's copy exists, the window closed with no save-as-draft prompt, and that nothing threw. **It cannot run in CI and that is not fixable here:** headless Ozone segfaults on the first `BrowserWindow`, hidden ones included, and there is no xvfb, so it needs a real display and pops windows on screen for a few seconds; `test:imap` stays the one CI runs. Docker orchestration moved to `scripts/greenmail.mjs` so both runners share it, each with its own container name and ports so they can run at the same time. Two failure modes are recorded in the docs as first suspects because this check has already hit both and *passed* while proving nothing: picking windows out of `getAllWindows()` by index (order is not creation order, and sending from the main window succeeds too, so the only symptom was a window that never closed), and opening the composer with a bare `draftId` via `compose.open`, which leaves `draftIdRef` null so the prompt cannot fire either way. The runner owns the temp `userData` because deleting it from inside the running app only lets SQLite recreate the WAL, and the harness bundle is written to `out/main/` (for `__dirname`) and deleted afterwards so a 6 MB stray cannot be packaged into a release.

- **A destroyed main window no longer throws `Object has been destroyed`** — found while building an end-to-end harness for the send path, not by a user report. `mainWindow` was read through `mainWindow?.` everywhere, which guards against *null* — and a destroyed `BrowserWindow` is not null, so the optional chain passes and the call throws. The reachable route is the compose window's `parent: mainWindow`: closing the main window destroys the composer with it, and the composer's own `closed` handler calls `notifyMessagesUpdated()` — badge, title, and a send to the renderer, all aimed at the window that has just gone. With close-to-tray off (or no tray at all) that raised two uncaught exceptions on the way out; with it on, the window only hides, which is why nobody had seen it. Reads now go through `liveMainWindow()`, and **both** of its checks matter: the webContents is destroyed *before* the window reports `isDestroyed()`, so a window-level check alone still let `webContents.send` throw — the first attempt at this fix failed for exactly that reason. Nulling `mainWindow` in its own `closed` handler is **not** sufficient either, because the child's `closed` runs first; it is nulled there anyway so the `?? undefined` fallbacks behave. `focusMainWindow` and the tray's window getter were the other live-reference readers — a `second-instance` or mailto arriving after the window had gone would have thrown the same way. Impact was small (it happened while the app was on its way out, and `reportUnexpectedError`'s own `isDestroyed()` check meant the user never saw a dialog), which is the argument for fixing it cheaply rather than not at all. Verified by a temporary Electron harness that reproduced it deterministically — 2 uncaught and an abnormal exit before, 0 and a clean exit after — and pinned in the suite by source-shape checks, since windows cannot be driven there.

- **Sending no longer asks whether to save the message as a draft** — `compose:send` ends by closing the composer, and the `close` handler is the keep-or-discard flow: it asked the renderer to flush, got a draft id back, and put up "Save this message as a draft?" about the message that had just been sent. The id was stale — `compose:send` deletes the draft as soon as `sendMail` resolves — so "Save draft" then toasted that a draft which no longer existed had been filed in a named folder, "Discard" deleted nothing, and "Cancel" left a window full of already-sent content open to be sent again. The autosave guard (`sendingRef`) was doing its job throughout: nothing was resurrected, but `__orbitMailFlushDraft` still handed back `draftIdRef.current` whether or not it had saved anything, which is what made the id look live. Fixed in main rather than the renderer, because main is what knows the send succeeded and what already deleted the row: `composeSentAndClosing` marks the close as the tail of a send and the handler returns on it. The mark is set only alongside a close that will actually happen and cleared in `closed`, so it cannot outlive the window and silence the prompt for the *next* message — which would have traded a nuisance for actual data loss. The close path lives inside `createComposeWindow` and has no window to drive in the suite, so it is pinned by source-shape checks next to the IPC-contract ones (mark present, mark before the close, handler short-circuits, mark cleared); each was confirmed to fail against a reverted copy rather than assumed to.

- **`npm run ui:preview` — looking at the UI without Electron** — `npm run dev` cannot start in this environment, so every UI change used to end with "someone please click through it", and things shipped unverified on that basis. It did not have to: the renderer is a plain React app, and the only reason it will not run in a browser is that it errors on a missing `window.orbitMail`. Stubbing that bridge is the trick `store-race.mjs` already used to reach renderer logic under node — this does it in a real DOM, so the result can be screenshotted and *looked at*. It immediately earned itself: it caught a spacing defect in the AI pane (the "API key" label butting against the "Status" row above, since `.account-info-row` had no bottom margin and `.account-field` no top one) that had been shipped and reviewed without anyone noticing. Fixed with an adjacent-sibling rule so the stats list in Accounts, where tight stacking is correct, is untouched. **The limitation is the point and is documented rather than glossed:** every IPC answer is a fixture, so a pane can look perfect while its channel is missing — `test:imap` covers that and this replaces none of it. And a fixture missing a field does not degrade, it *throws* inside the component with a stack indistinguishable from an app bug; the first two panes tried both crashed that way (`AccountInfo` and `ManualAccountSettings` were fuller than the fixtures), which is why the script says to suspect the fixture first.

- **Model and effort are chosen in Settings → AI, and a sweep can be forced** — the model was hardcoded (`const MODEL = 'claude-opus-4-8'`) and effort pinned to `low` at all four call sites. Both are now preferences read **per request** by `modelConfig()`, so a change applies to the next action rather than the next launch, and the main process reads them from the preferences blob itself — the renderer never tells main which model to call. The catalogue lives in `shared/ai-models.ts` because both sides need it: the pane renders it, main validates against it. **The values are untrusted input**, not settings: they arrive from a JSON blob a previous build or a hand edit may have written, so `resolveAiModel`/`resolveAiEffort` fall back rather than pass an unknown string to the API, where it would 404 every AI feature at once. `max_tokens` went up at all four call sites in the same change — it bounds thinking *and* the reply together, and Claude Opus 5 (the new default) thinks by default where Opus 4.8 did not, so a budget sized for the JSON alone gets spent reasoning and truncates; the schema-constrained parse then rejects the result, which surfaces as "the model returned nothing usable" rather than as a token limit. The per-message sweep cache is never invalidated on its own — an IMAP body does not change, so the only reason to re-read one is that *we* changed — so **Re-analyze all** is a separate, confirmed button that says what it will spend, rather than something a re-sweep does silently.
- **Packaged filenames no longer contain spaces** — `artifactName` used `${productName}` ("Orbit Mail"), so releases shipped `Orbit Mail-0.5.0-…`, which GitHub rewrites to `Orbit.Mail-0.5.0-…` on upload. The names on the release page then matched neither the local files nor the published checksums. Switched to `${name}` (`orbit-mail`), which already matches `executableName`. The install commands in README and INSTALL.md quoted the old spaced glob and were updated with it.
- **Draft UX fixes from real use** — three things testing found. Closing the composer now **asks** whether to keep the draft instead of keeping it silently: an unsent message quietly filed somewhere is indistinguishable from one lost, and drafts accumulated from composers opened and thought better of. The order is save-then-ask, so a failure between question and answer cannot lose the message; Cancel returns to editing. Clicking a draft in the list **selected** nothing — it opened the composer outright, which meant a draft could not be read, and could not be deleted either, since deletion works on the selection. A draft is now projected into a `MessageDetail` by `getDraftAsMessage` so `messages:get` serves it and the reader needs no separate path; single click selects, double-click opens, and the reader header swaps Reply/Reply All/Forward for **Continue editing** and **Discard draft**.
- **The quoted original is editable and removable** — expanding it makes it `contentEditable` so it can be cut down to the part being answered, and the divider carries a Remove control. It was read-only and always included on send. The structure did most of the work: the quote has always travelled separately from the body and is only combined on send, now by `joinBodyWithQuote`, so whatever that is handed is what goes out. Details that needed thought: the quote is **uncontrolled** like the body editor, because letting React own its `innerHTML` resets the caret on every keystroke; send reads the **DOM rather than React state**, since `onInput`'s re-render may not have flushed when Send is clicked and state can be one edit behind; the plain-text half is regenerated from `innerText`, because a stored `quotedText` describes a quote that is no longer being sent once the HTML is trimmed, and the two MIME parts would disagree; and a quote emptied line by line is treated as removed rather than sent as a pair of `<br>`s and a blank gap, while a quote holding only an image is kept.
- **Per-account signatures** — rich HTML, stored on the account row, edited in Settings → Accounts with the same editor the composer uses, so a signature can carry a pasted logo (which is just an inline image, hence doing those first). **Appending to `bodyHtml` is what places it above the quoted text**: the quote travels separately in `quotedHtml` and is rendered below, so `appendSignature` needs no positioning logic and should not grow any. The case that would have bitten: reopening a **draft** must not re-append, since the signature is already part of that draft's saved body — without the guard you collect one copy per reopen, and there is a test for it. A whitespace-only signature stores as none, or an emptied editor leaves a stray `<br>` on every message forever. Sanitized in the renderer on save because `sanitizeEmailHtml` needs a DOM the main process does not have; `RichTextEditor` cleans it again on mount, which every compose passes through.
- **Inline and pasted images in compose** — pasting or dropping an image into the body embeds it. The editor holds it as a data: URI (which is what lets a draft keep one with no file on disk, and survives sanitizing because DOMPurify allows `data:` on `img src` by default), and `extractInlineImages` converts each to its own MIME part with a Content-ID at send time. **Sending them as data: URIs would have been simpler and wrong** — Gmail and Outlook strip those from received HTML, so the recipient sees a blank space; `cid` is also what makes nodemailer build `multipart/related` and mark the part inline rather than a download. Identical images pasted twice stay two parts, because deduplicating by content is how "why did that image change" bugs start; remote images in the body are left alone, since rewriting one changes what the recipient fetches; 5MB per image, refused with a message rather than silently. **Reading them needs nothing**: `simpleParser` rewrites `cid:` to data: while parsing, before the body is stored, so received inline images already render — a `content_id` column and a reader-side resolver were built on the opposite assumption (grepping this codebase for `cid:` handling finds none, because the work is mailparser's) and thrown away. Established on the way: DOMPurify's default URI allowlist **blocks `file:`**, while `data:` is permitted on `img` via its DATA_URI_TAGS path, which is exactly why pasted images survive sanitizing.
- **Compose defaults to the account you are reading** — every entry point (toolbar, `C`, the `c` shortcut) used `accounts[0]`, so composing while reading a second account sent from the first. Invisible until drafts existed, at which point the draft was saved under an account the user was not looking at and read as lost. `composeAccountId()` resolves the selected folder's account, and closing the composer now names the account its draft went to.
- **Draft autosave** — compose saves to a local `drafts` table as you type (800ms debounce); closing the window keeps what was written, and the Drafts folder lists them alongside anything the server holds. Clicking one reopens the composer; deleting one discards it rather than trying to trash a message the server has never heard of. **Drafts are deliberately not rows in `messages`**: a draft has no server uid, and the expunge reconciliation deletes any local row whose uid is absent from the server's list, so a draft parked in the Drafts folder would be deleted by the next sync of that folder. They are scoped to an account rather than a folder, so the Drafts folder is resolved at query time and a draft survives it being renamed or re-typed. Local only — see the outstanding IMAP-upload entry for what syncing them would cost. Details that took a test to get right: `saveDraft` **replaces** the row rather than merging, because the composer sends its whole state and merging would make an emptied Cc impossible to save (the cost being that a partial payload drops threading headers — the suite pins that a resumed reply still threads); the draft id is a *ref*, not state, or every keystroke burst creates a new draft; closing defers while `__orbitMailFlushDraft` runs, since the debounce can hold ~800ms of typing, with a 2s backstop so a wedged renderer cannot trap the window; the draft is deleted **after** `sendMail` resolves, never before, or a failed send loses the message; a send in flight suppresses autosave so a late timer cannot resurrect what was just sent; and `listThreads` builds its draft rows **before** the `heads.length === 0` early return — the test caught a Drafts folder holding only local drafts rendering empty in threaded view while the flat list showed them.
- **Block and mute a sender actually do something** — both used to persist a string and change nothing: the app said it had blocked someone and then delivered their mail as normal. **Mute** now means "do not interrupt me" — the mail arrives, is listed and counts as unread, but `getLatestInboxMessage` skips muted senders and the notification is suppressed. Deliberately *not* auto-mark-read, which destroys information and cannot be undone. **Block** means "do not put this in front of me" and filters at **query time**, in every read site: `listMessages`, `countMessages`, `listThreads` (twice — the folder scan *and* the message rows, so a blocked reply does not contribute to an otherwise legitimate thread), `countThreads`, `searchMessages`, `getLatestInboxMessage` and `recalculateFolderUnread`. They have to land together: the bug that would actually ship is not "block does not work" but "block works in the list and not in the count", leaving an unread badge for mail nobody can see. Sync-time was rejected twice over — re-filing into Junk collides with `UNIQUE(folder_id, uid)`, and skipping at ingest is unrecoverable because IMAP only fetches UIDs above `highestSyncedUid`, making Block silent irreversible data loss that behaves one way for cached mail and another for new. The predicate matches `<addr>` or a bare address and **never a bare substring**, because `LIKE '%bob@x.com%'` would also hide `notbob@x.com`. Sent folders are exempt *and* `blockSender` refuses one of the user's own addresses — either alone would do, both are cheap, and without them blocking your own address empties your Sent list. Nothing is deleted, so unblocking restores everything with no refetch. The Privacy pane lists all three sender lists with an undo on each, and blocking now raises a toast: hiding mail silently is indistinguishable from losing it.
- **Settings → Accounts: editing IMAP/POP3 server settings** — server, port, security, username and password for a manual account, with a **Test connection** button. The service to test settings (`testManualAccountInput`) already existed and had never had a channel. The care here is all in one place: `getManualCredentials` returns the **plaintext password**, so `accounts:getManualSettings` projects through `toManualSettings`, which builds the result **field by field and never spreads** — a `{ ...creds }`, or a later `omit`-style denylist helper, is one careless edit from serialising a password into the process whose entire job is rendering untrusted email HTML. The renderer learns only `hasPassword`; the test asserts on the **absence of the key**, because `password: undefined` still serialises the field name. An omitted password means "keep the stored one", resolved in main rather than round-tripped. Email and protocol are read-only: `saveManualAccount` matches on *email* so a changed address would fork the account into a second row, and `assertProviderUnchanged` refuses an IMAP↔POP3 switch outright. Settings are **verified before they are persisted** — saving a broken host would strand the account with no route back but the Add Account wizard — and both the save and the test run under a 30s timeout, because `testManualAccountInput` does a live login plus an SMTP verify and only POP3 has a socket timeout of its own. After a change main closes the account's IMAP pool and restarts IDLE, since both are still authenticated with what was just replaced.
- **Settings → Accounts** — display name, sync window, account stats, Sync now and removal, collected in one pane. All of it existed already and none of it was anywhere sensible: renaming was a `window.prompt` in the *folder* context menu, the sync window lived in a dialog you could only reach by right-clicking a folder → Get Account Info, and removal was a `window.confirm` that named the address and nothing else. No new IPC — `accounts:getInfo/updateDisplayName/updateSyncDays/remove` and `sync:refresh` were all already there; this is entirely a matter of putting them where someone would look. Removal is now a two-step confirm **inside** the pane that says how many messages and how many bytes are about to go, which an OS dialog stacked on a modal could not. `AccountInfoDialog` is deleted; the sidebar gear and the folder context menu both open this pane on the account in question. `resolveSelectedAccountId` is exported and tested because its failure mode is invisible until it bites: remove the selected account and the pane is left pointing at an id that no longer exists, rendering nothing. `ServerFields` was lifted out of `AddAccountWizard` unchanged, ready for the credential-editing PR that follows.
- **A settings screen, and the four toggles that were waiting on one** — three entries in this file said in so many words that a setting could not exist because there was nowhere to put it. The shell (`src/components/settings/SettingsDialog.tsx`) is the usual modal skeleton plus a category rail, opened by a toolbar gear, `Ctrl/Cmd+,`, or `openSettings(category, accountId)`; `AiSettingsDialog` became `AiPane` inside it. Now settable: close-to-tray, desktop notifications, `mailto:` handling — which was *already wired end to end* and had simply never had a caller — and a global always-load-remote-images. **The defaults are the upgrade path**, not a detail: every existing install has an `app_state` blob written before these keys existed, so each default equals what the app already did (tray and notifications on, remote images blocked) and consumers read `!== false` / `=== true` so an absent key means today's behaviour in both directions. No migration, no version field. While here, the duplicated `PersistedAppState` / `UiPreferences` declarations were collapsed onto the one in `shared/types.ts` — they had already drifted, with the sender arrays required in one copy and optional in the other. **No toggle is allowed to lie**: `app:getPlatformCapabilities` reports whether a tray and notifications exist so a dead control is disabled with a reason rather than flipping while nothing happens, and `preferences:setHandleMailtoLinks` now returns the live `app.isDefaultProtocolClient('mailto')` instead of echoing its argument, because on Linux the registration needs an installed `.desktop` file and silently no-ops in a dev build. Also fixed here because the screen made it acute: **`App.tsx`'s global keydown handler was not dialog-aware** — it only skipped `INPUT`/`TEXTAREA`, so with a button-focused dialog open, `f` opened a Forward window behind it and `Delete` deleted the mail still selected underneath.
- **Forward: a button on the message, and the attachments actually go** — forwarding was *mostly* built (global toolbar, Message menu, right-click, and `buildReplyPayload`'s `forward` / `forward-attachment` cases) which is why it read as missing rather than being missing: the reader header — where Reply and Reply All live, and the only place most people look — had no Forward button, so the feature was invisible where it mattered. Added there for both the single-message and conversation readers. The substantive bug behind it: a plain forward carried only the quoted body, so the original's **attachments were silently dropped** — the quoted text still said "see attached", the recipient got nothing, and neither end got a signal. `localizeMessageAttachments` now downloads any part not already cached and main approves the paths; `forward-attachment` is untouched, since the `.eml` it sends already contains them. A part that cannot be fetched no longer sinks the forward — the reachable ones go and the failures are named through the new `ComposePayload.notice`. Which exposed a third thing: the compose window never rendered a `<Toast />` (it is a separate `BrowserWindow`), so **every message it raised was invisible — including "Failed to send"**. Fixed in the same change, because the forward notice needed somewhere to land. Reply/Reply All/Forward were then **removed from the global toolbar**: they act on one message, so they belong on the message, and up there they were dead controls a good part of the time — `selectThread` nulls `selectedMessage`, and the buttons were `disabled={!selectedMessage}`, so opening a conversation greyed out Reply with a conversation on screen. The toolbar keeps what acts on the list or the app. The `R` shortcut is unaffected: it lives in `App.tsx` and already falls back to the open thread's latest message, which is precisely what the toolbar button failed to do.
- **Recipient autocomplete in compose** — To/Cc/Bcc suggest addresses as you type. There is no address book and nothing synced from a server: the `contacts` table is a by-product of mail already handled, harvested in `upsertMessage` (new messages only — counting a re-sync would inflate whoever synced most often) and again on a successful send, so an address you just used autocompletes on the next compose without waiting for a Sent sync. The ranking decision that matters: every address with `sent_count > 0` sorts above every address without one, so a daily newsletter cannot outrank a colleague written to once; within a tier it is prefix-match, then frequency, then recency. Scoped per account (chosen over a shared pool so a personal contact cannot surface in a work compose window) via a cascading FK, which also means removing an account clears what it collected. Mail that predates the feature is picked up by a background backfill that walks `messages` by rowid and advances a cursor in `app_preferences` inside the same transaction as its writes, so an interrupted run resumes instead of double-counting; it shares `drainInBackground` with the existing `search_text` backfill. The fields stay free text — the same comma-separated string the send path always took, with autocomplete rewriting only the token under the caret — rather than Gmail-style chips, which would have reworked how recipients are parsed and serialised on send for a cosmetic gain. **Deliberately not done:** editing, merging or deleting a single collected address (needs a contacts surface; the settings screen now exists to host one), and importing from CardDAV or Google Contacts. A one-off correspondent is collected like anyone else — ranked bottom, but present.
- **AI drafts choose reply or reply-all** — the "Draft reply ▾" menu now opens with a segmented **Reply / Reply All** toggle above the tone list. The mode was already plumbed end to end (`ai:draftReply` accepted it, `compose.open`/`buildReplyPayload` filled Cc from it) but nothing could set it and `ai-service` ignored it, so every AI draft was a reply to the sender and read like one. Two changes: the UI can pick it, and the prompt now knows who it is writing to — reply-all also passes the other recipients (fenced, they are header content) so the wording addresses the group. The toggle is sticky for the session (`draftReplyMode` in `mailStore`) rather than six menu rows (3 tones × 2 modes), so choosing a tone stays one click and the mode is a one-off for a thread where it matters. Reply All is offered unconditionally, matching the reader's existing Reply/Reply All buttons — deciding whether it would add anyone means duplicating `buildReplyAllCc`'s self/sender exclusions in the renderer, and getting that wrong hides a real choice. Instead, when there are no other recipients the draft prompt says so and writes to the sender alone.
- **Close minimises to the tray; quitting is explicit** — closing the main window now hides it (`event.preventDefault()` + `hide()`) rather than quitting, so sync and the tray count carry on in the background, the way most mail clients behave. A real quit — the tray's **Quit** or **File → Quit** (Ctrl+Q) — fires `before-quit`, which sets an `isQuitting` flag before the window closes so the `close` handler lets it through. Gated on `isTrayActive()`: with no tray there is nothing to reopen from, so those platforms close-to-quit as before. The fail-safe for a desktop that makes a tray it never draws is `second-instance` always calling `focusMainWindow()` — re-launching un-hides the window. macOS/Windows behaviour is unchanged. The opt-out now exists in Settings → General (see the settings-screen entry above).
- **Delete to Trash** via `Delete` / `Backspace`, with provider-correct trash resolution (SPECIAL-USE `\Trash`), optimistic list removal, and a destination-named toast.
- **Unread-count badge** on the taskbar / launcher and in the window title.
- **Optional AI** (bring-your-own Anthropic key): per-message **Analyze** (summary, action items, questions, key context) and an inbox **Tasks** sweep (choice of **Unread** (default) or **All messages**). Sweep results and ticked-off tasks are persisted per folder; completed tasks are fed back to the model so they don't resurface. The task list can be printed for an account or exported to a Markdown file on demand.
- **Rich compose editor** — extended formatting toolbar (headings, bold/italic/underline/strikethrough, alignment, colour, lists, links, quote, inline code, clear), HTML send, collapsible quoted text on replies/forwards with an attribution line and separator, and a drag-and-drop attachment UI showing type icons and sizes.
- **Conversation threading** — messages group by RFC 5322 headers (`thread_id` derived from `References`/`In-Reply-To`, subject fallback) into one collapsed row per conversation; opening a thread loads the full **account-wide** conversation across folders (Sent replies interleaved) in a stacked, collapsible reader. Includes AI **reply drafts** with tone options (Brief/Neutral/Detailed).
- **Performance & perceived-speed pass (phases 1–3)** — tuned SQLite pragmas + `COUNT(*)` + summary-column projection + partial unread index + batched sync writes; optimistic read/star/flag/move/delete with rollback and an instant-painting reader; `virtua`-virtualized message list with memoized rows and reference-preserving refresh; folder-switch skeletons; a pooled per-account IMAP client with a per-account op mutex; parallel account sync; cached Sent path; send does a Sent-only sync; attachments fetch just their BODYSTRUCTURE part.
- **Bring-your-own-credentials** setup documented (INSTALL.md → "Register an OAuth app"; DEVELOPERS.md → OAuth setup + verification/CASA notes).
- **Search upgrades** — scoped search (**All/From/To/Subject/Body**, persisted in `UiPreferences`) that now also matches sender/recipient (previously subject/snippet/body only); a one-click clear button; and a live **server-side (IMAP) fallback** that searches the whole mailbox when the local cache has no match (or on demand via *Search whole mailbox*), importing matches so they open like any cached message. POP3 has no server-side search.
- **Sync reconciliation** — server-side deletions (EXPUNGE) are reconciled into the local cache, and flag/expunge changes are pushed over IMAP IDLE.
- **AI attachments in Analyze** — per-message **Analyze** can optionally include a message's attachments for extra context (opt-in prompt, since it costs more tokens).
- **Quality-of-life fixes** — dark-mode attachment-chip contrast, search clear button, and an attachment paperclip on message-list rows.
- **Attachment save-as** — per-attachment **Save** and **Save all** actions, plus a right-click *Save attachment* context menu, with a download path picker.
- **Manual reply** — a primary, non-AI **Reply** action in the reader (opens the composer with quoted text); the AI reply-draft is demoted to a secondary action.
- **Tray icon carrying the unread count** — the launcher badge is invisible on Cinnamon (its window-list applet implements no Unity `LauncherEntry` support), so the count now also goes to a system tray icon, which the panel draws itself via StatusNotifierItem (`xapp-sn-watcher` on Mint). Electron's `Tray` exposes no text label on Linux, so the number is baked into pre-rendered icons — `npm run icons` emits `build/icons/tray/` — and `updateAppBadge` swaps between them, clamping past nine and keeping the exact figure in the tooltip. Also removed the `--class orbit-mail` switch in `app-icon.ts`: `app.setName('Orbit Mail')` runs before the window is created and wins, so the switch never took effect and only made the desktop files look right when they were wrong. Closing the window now hides it to the tray rather than quitting (see the "Close minimises to the tray" entry above); the setting to turn that off now exists in Settings → General.
- **Launcher badge attribution, and honesty about it** — `StartupWMClass` read `orbit-mail` in both the dev launcher and the packaged desktop entry, while the window announces `WM_CLASS = "orbit mail", "Orbit Mail"` (Chromium derives it from the `app.setName('Orbit Mail')` call in `main.ts`). No desktop could tie the window to the entry, which breaks pinning and grouping as well as any launcher badge; `npm run test:imap` now checks both entries against the name `main.ts` sets. Separately, the docs claimed a taskbar badge without qualification: Cinnamon's `grouped-window-list` has no Unity `LauncherEntry` support at all, so the emit is correct and simply ignored there, and a number on the panel icon is the desktop's own notification badge rather than Orbit Mail's. README and DEVELOPERS.md now say so, with a troubleshooting entry for "the number on the icon disagrees with the app" (the window title is the all-accounts total; a folder badge is one folder).
- **Folder roles prefer the account's own folder** — an Exchange account with an old IMAP tree imported under `INBOX/admin/…` and `INBOX/info/…` offers a second `Sent Items` and `Junk Email`, carrying their own SPECIAL-USE flags, and the empty grafted copies won the roles: Sent listed nothing and sent mail would file into a stranger's folder. `detectFolderTypes` now ranks candidates: ours before a grafted mailbox's (two or more levels under `INBOX` — one level is Courier-style namespacing and stays eligible), then a SPECIAL-USE flag before a name guess, then the shallowest path, then first-listed. The graft rule has to come first because on this account *only* the grafted `Sent Items` was flagged — it brought its flags with it, and a flag from somebody else's mailbox says nothing about ours. Flags still outrank depth, or the Gmail `[Gmail]/Bin` fix would come undone. `resolveRoleMailbox` applies the same ranking for send-filing and the post-send sync, which each used to take the first mailbox that looked Sent — so sent copies filed into the grafted folder and disagreed with the sidebar. `Junk Email`/`Junk E-mail` added to the name-map fallback.
- **Thread-level context menu and multi-thread select** (#76, #80) — the conversation context menu acts on whole conversations (archive, move, delete, flag, mark read/unread), and rows multi-select with shift/ctrl-click, closing the two Post-MVP items that described threads as open-and-delete only.
- **Bulk archive and move** — archive, move and the context menu now act on a multi-selection in both views, batched into one `messages:moveMany` (a second channel alongside `deleteMany`, same handler — the two names exist so a delete call site and an archive call site each read honestly). Right-clicking inside a selection acts on all of it and the menu says so ("Archive 3 conversations"); right-clicking outside it acts on that row alone. The three bulk conversation actions share one spine that differs only in each message's destination, and the toolbar's Delete/Archive — which took `selectedMessageId` only, so they were dead in the default conversation view — now follow the selection in either view. A message already in the destination is skipped rather than round-tripped.
- **Multi-select in conversation view** — shift-click a range and ctrl/cmd-click individual conversations, with Delete acting on the whole selection in one batched call. Previously thread rows went straight to `selectThread`, so the range/toggle handlers existed only for flat rows and bulk delete meant switching the list out of its default view. Two bugs the new store tests caught while building it: a slow `getThread` re-applying a superseded selection, and `selectThread` moving the anchor to the lead row so a range could never be shrunk back. Archive/move and the context menu still act on one conversation — not yet wired to the selection.
- **Deleted Gmail mail actually goes to the Bin** — `detectFolderType` iterated imapflow's `specialUse`, which is a *single string* (`"\\Trash"`), as if it were an array, so it walked the characters, matched nothing, and every folder was typed from its English name. On en-GB Gmail the real Trash is `[Gmail]/Bin`, which the name map did not know, so one account handed the trash role to a legacy user folder called "Deleted Items" (deletes became an ordinary label change — and on Gmail a label change keeps every other label, so the message stayed in All Mail, search and thread views) and another had no trash folder at all, falling back to `\Deleted`+EXPUNGE, which on Gmail only removes the INBOX label. Found from a real profile: 13 messages sat in both a trash folder and All Mail/Important, which Gmail never does server-side. Now `detectFolderTypes` types the whole account in one pass with SPECIAL-USE authoritative (a folder merely *named* like a role is demoted when the server flags a different one), `Bin` is in the name-map fallback, and `upsertFolder` re-types on every sync — previously the type was frozen at first sight, so no detection fix could reach an existing install.
- **Deletes stay deleted** — a list refresh landing while a delete/archive/move was still in flight resurrected the row: the main process removes the local SQLite row only *after* the IMAP round-trip, so any refresh in that window (sync-complete, `sync:messagesUpdated`, background poll, IDLE push — including the poll the delete path fires itself) re-read a DB that still held the message. Rows are now held out of any page applied while their op is in flight (`withPendingRemoval`), released when it settles, and released *before* a failure's rollback refresh so a rejected delete still restores the row. Covered by `npm run test:store`.
- **Removing a row advances the selection** — delete, archive, junk and move all move to the next row down (the row above when it was the last one), matching Apple Mail/Outlook/Thunderbird, instead of emptying the reader; acting on a row that isn't selected leaves the reader alone. One pair of helpers (`removeMessagesAndAdvance` / `removeThreadAndAdvance`) now backs every message- and thread-level action, replacing five copies of the clear-the-selection block.
- **Sent rows name the recipient** — in any account's Sent folder the list row shows who the mail went to instead of the sender (always the account owner), in threaded, flat, expanded-thread-child and search views; multiple recipients read as `A, B, +N`, deduped per address so one person written two ways is listed once.
- **Reply All** — replies to the sender plus all other To/Cc recipients (self and the original sender de-duplicated), exposed as a visible button in the single-message and thread reader headers and the toolbar, alongside the existing right-click context-menu entry.

- **AI reply drafts** — tone-steered (Brief / Neutral / Detailed) reply drafts grounded in the whole conversation, opened in the composer for editing.

- **Bulk delete is transactional, and ordered safely** (#94) — `deleteMessages` removes a batch in one transaction, recounts each affected folder's unread once instead of once per row (a 5,000-message prune did 5,000 recounts), and unlinks attachment files *after* the rows are gone. The old order left rows pointing at deleted files if a crash landed in between — an attachment the reader offers and cannot open; the new order leaves files with no rows, which is wasted space and nothing more. `clearFolderMessages` follows the same rule, and the per-message file helper it shared with the old path is gone. Not addressed: files orphaned by crashes *before* this change stay on disk, with no sweep to reclaim them.

- **Preferences no longer lose the last change at quit** (#95) — three faults in one path. `before-quit` fired the renderer flush and carried on quitting, and the flush itself was fire-and-forget inside the renderer, so nothing waited for the write: change a setting, quit, and it was as if you had not. Quit now defers until the flush's promise resolves, with a 2s timeout so a wedged renderer cannot hold the app open. `getAppState()` returns a copy instead of the cached object, which a caller could mutate to make memory and disk disagree. And `writeRawState` skips a write that would change nothing — the debounced UI save fires on selection changes that often change nothing, and every such write rewrote the sender lists sharing that row. Not addressed: the state is still one blob rather than separate rows, which is a storage migration rather than a bug.

- **Uncaught errors are surfaced, not swallowed** (#96) — the handler existed to suppress IMAP socket timeouts and suppressed everything, logging to a console no user sees. The suppression is now narrow and named (`isBenignSocketError`), everything else is logged and reported to the renderer once per run as a toast, and unhandled rejections route to the same place with their own label. Quitting on any uncaught error was rejected: a stray background fault would cost the user their session, so they are told and left to pick the moment. The one `void` call without a `.catch()` (`reconcileAllAccountsFlags` after a manual refresh) now handles its own failure, which is what would otherwise have arrived here as an uncaught exception.

- **The pool closes an unusable client before replacing it** (#97) — `usable` goes false when a protocol error is seen, which is before `close` fires and on a half-open connection perhaps never, so overwriting the reference leaked the local socket and the server-side slot. Gmail allows 15 IMAP connections per account and the app budgets two, so a steady leak is how an account starts refusing new ones. `reclaimClient` makes the decision explicit and testable, and uses `close()` rather than `logout()` — the client is already unusable, so a polite LOGOUT has nobody to talk to and could hang the lane.

- **POP3 identifies messages by UIDL, not a hash of it** (#98) — the `uid` column is an integer modelled on IMAP, so POP3's UIDL string was squeezed into a 32-bit hash and every decision made on that: at ~1% collision for 10k messages, a collision made new mail look already-synced, or pointed `DELE` at whichever message hashed the same — unrecoverable, since POP3 has no trash. The UIDL is now stored in `messages.server_uid` (added to the Drizzle table, the `CREATE TABLE`, and an appended `ALTER TABLE` step) and is what identity means; the hash remains only to fill the integer column. A message synced before the column existed has no UIDL, so a server-side delete refuses rather than guessing. Still open: the same hash helper is duplicated in `attachment-fetch.ts`, where it maps a cached attachment back to a POP3 message — same collision risk, narrower blast radius (a wrong attachment fetched, not mail deleted).

- **mbox export is faithful** (#99) — three faults in one function. Lines beginning `From ` inside a body were not escaped, so every such line split the message in any reader, including on import back; escaping is now mboxrd (`>*From ` gains a marker), which is reversible where mboxo is not. Sources were decoded with `toString('utf8')`, mangling anything that was not UTF-8; the writer now works entirely in `Buffer`s, scanning lines via `latin1` because it round-trips bytes exactly. And it materialised the mailbox three times — `fetchAll`, then an array of parts, then one joined string — where it now streams message by message to an owner-only file. The separator also carries a proper asctime date instead of `toUTCString()`.

- **POP3 checks the sync window before downloading** (#100) — the check ran after `RETR`, which pulls the whole message including attachments, and an out-of-window message is never stored, so it was downloaded and MIME-parsed again on every poll, twenty seconds apart, indefinitely. The date now comes from `TOP msgNum 0` (headers only). A missing or unparseable `Date` yields null and never skips — not knowing the date must not be treated as knowing it is old — and a server without `TOP` (it is optional in RFC 1939) falls through to the original check, no worse than before.

## Security & correctness audit (2026-07-21)

Full-codebase audit of the desktop app (Android port excluded). Findings are ranked by severity; file:line references were current at commit `0967177`. Everything below is **unfixed** unless marked.

> Security-relevant entries are stated as what to change and where, without reproduction detail, since this repo is public and these are open items.

**Fixed in #29 (renderer isolation):** untrusted email HTML could reach navigation sinks and `style`-based overlays that DOMPurify's defaults permit, and the `mailto:` body reached the compose editor's `innerHTML` unescaped. Three layers added: an expanded shared sanitizer (`src/utils/sanitizeEmailHtml.ts`), `will-navigate` blocking on both windows, and a renderer CSP.

**Fixed in #30 (IMAP sync):** the three High-severity sync defects — STARTTLS enforcement, the IDLE reconnect deadlock, and the UIDVALIDITY cache wipe. Struck through below.

Remaining items still reference the audit-time line numbers, which have shifted in `electron/services/imap-sync.ts`, `imap-idle.ts`, `smtp-send.ts` and `account-credentials.ts` since those two merges.

### High — fixed

- ~~**STARTTLS is not enforced on IMAP or SMTP-OAuth.**~~ **Fixed** (#30) — `imapConnectionSecurity()` replaces `imapFlowSecure()` and maps `'starttls'` to `{ secure: false, doSTARTTLS: true }`, making the upgrade mandatory; `createOAuthTransport` now sets `requireTLS: true`. Note the behaviour change: an account configured as STARTTLS against a server that does not offer it now fails to connect instead of silently continuing unencrypted.
- ~~**IDLE never reconnects — push mail dies silently.**~~ **Fixed** (#30) — the runtime entry is kept until the reconnect timer fires, so `scheduleIdleReconnect` can find it. Reconnects now actually happen, so they back off exponentially (5s → 5 min cap, reset on a successful connect).
- ~~**Sent mail never filed for manual IMAP accounts.**~~ **Fixed** (#32) — the MIME message is now built up front with `MailComposer` and that exact buffer is both submitted and appended to `Sent`, so the filed copy shares the delivered copy's Message-ID. The append is scoped to `provider === 'imap'`; Gmail files SMTP-submitted mail itself and would otherwise end up with two copies. Two loose ends it leaves behind:
- ~~**UIDVALIDITY change destroys the local cache.**~~ **Fixed** (#30) — the restore set is resolved from the server rather than filtered against stale local UIDs (which silently dropped every colliding message), sized to what was cached and refilled in batches. `uidValidity` is only written after a successful refill, so an interrupted resync retries.
- ~~**POP3 has no socket timeout, and one stall wedges all sync.**~~ **Fixed** (#61) — `pop3ClientOptions` now sets a 60s socket timeout, which node-pop3 requires to arm its inactivity timer. A stalled connection (accepts TCP but never greets, or stalls mid-`RETR`) now rejects instead of hanging forever, so the per-account try/catch in `pollForNewMessages` recovers and `syncStatus.syncing` is cleared rather than stuck true. Guarded end-to-end by a suite check: a silent TCP server rejects in ~800ms instead of hanging.
- ~~**FTS index deletes are a permanent no-op.**~~ **Fixed by removal** (#36) — `messages_fts` was contentless, so `DELETE ... WHERE message_id = ?` could never match (a contentless FTS5 table reads every column back as NULL) and it accumulated a duplicate row per re-index. Nothing ever queried it: there was no `MATCH` anywhere in the codebase, and `searchMessages` has always used `LIKE`. It was dropped rather than repaired — indexing cost ~0.5ms per synced message and ~8MB for a write-only structure. Search behaviour is unchanged (verified: identical result hashes before and after).
- ~~**`listThreads`/`countThreads` scan the whole account per render.**~~ **Partly fixed** (#35) — two expression indexes on `COALESCE(thread_id, id)` cut `listThreads` 57.7ms → 35.4ms and `countThreads` 3.9ms → 1.0ms on a real 3.3k-message profile (cold-cache raw query 119ms → 39ms), for ~0.9MB of index. Query rewrites were measured and rejected: a materialized CTE was a wash and a CTE join was worse.
  - `countThreads` is now effectively free, so only the list query is worth further work.

### Medium — fixed

- ~~**OAuth flows need PKCE and `state` validation.**~~ **Fixed** (#37) — both flows now send a PKCE challenge (S256) and a per-attempt random `state`, which the loopback listener checks before accepting a code. A mismatched callback is answered and ignored rather than treated as an error, so a hostile page cannot abort a real sign-in by racing it. The listener also has a 5-minute timeout and closes on every path, including an abandoned or failed attempt. Covered by the integration suite.
- ~~**Credential storage falls back to base64** with no warning~~ **Fixed** (#62) — the fallback is intentional (the app must still work without a keyring), but it was silent. It is now surfaced: the main process logs a warning at startup when `safeStorage` is unavailable, and a dismissible banner tells the user that saved passwords, tokens and API keys are obfuscated rather than encrypted, and to install a keyring. Exposed via `app.getSecureStorageStatus()`.
- ~~**`attachments:open` hands the file straight to the OS opener**~~ **Fixed** (#42) — opening an attachment whose extension can execute (`.desktop`, `.sh`, `.run`, `.jar`, `.exe`, and the rest) now shows a warning naming the real extension, defaulting to Cancel. A `.pdf.exe` reads as a PDF in the list; the prompt says otherwise.
- ~~**`shell:openExternal` does not validate the scheme.**~~ **Fixed** (#64) — a shared `isSafeExternalUrl` helper restricts the OS opener to `http`/`https`/`mailto`, applied to the `shell:openExternal` IPC handler *and* both `setWindowOpenHandler`s (which fire on `window.open`/`target=_blank` from message content — the same untrusted sink). Anything else is dropped rather than launched, so a `file:` or custom-scheme link in email HTML can no longer invoke an arbitrary handler. The `will-navigate` guard was already stricter (http/https only).
- ~~**STARTTLS autoconfig misparsed as implicit SSL.**~~ **Fixed** (#65) — `parseSecurity` tested `includes('tls')` before the `starttls` branch, and `'starttls'.includes('tls')` is true, so an autodetected STARTTLS `socketType` was stored as `ssl` and hung on a TLS handshake against its plaintext port (143/587). The type string is now authoritative and STARTTLS is checked before SSL/TLS, with a well-known-port fallback only when no `socketType` is given. `parseAutoconfigXml` is exported and the suite pins the classification (STARTTLS→starttls, SSL→ssl, port fallback).
- ~~**No index on `attachments.message_id`**~~ **Fixed** (#66) — `attachments_message_id_idx` added to `initTables` (fresh DBs), `migrateSchema` (existing DBs) and the Drizzle `schema.ts`. Every attachment read is by `message_id` and the `ON DELETE CASCADE` walks the same key, so the open path and the delete cascade no longer full-scan. The suite asserts the planner actually uses it (`EXPLAIN QUERY PLAN`), not just that it exists.
- ~~**`migrateFtsIndex` loads every body into one array.**~~ **Moot** — the FTS index and its migration were removed entirely (#36); `migrateFtsIndex` no longer exists. The startup-OOM path it described is gone with it.
- ~~**Unbounded attachment buffering during sync**~~ **Fixed** (#67) — the batch `pending` array held each message's parsed attachment `Buffer`s until the whole folder's fetch was written (~2GB for a folder of large attachments), though only filename/type/size are ever stored. Each attachment is now reduced to metadata (`toAttachmentMeta`) as soon as the message is parsed, so the Buffer is freed per-message instead of retained across the batch. Content is re-fetched on open, as before. The suite pins the reduction's field/size-fallback semantics.
- ~~**Packaged builds can't do OAuth.**~~ **Fixed** (#45, #46) — credentials resolve at runtime: environment, then `~/.config/orbit-mail/.env`, then values entered in the app when adding an account (stored encrypted via safeStorage). Deliberately never baked into the build — that would ship the builder's own client secret in every package (CLAUDE.md rule 5, enforced by tests).
- ~~**Unguarded DDL in `migrateSchema`**~~ **Fixed** (#68) — the `UNIQUE` index on `(folder_id, uid)` postdates the MVP, and a pre-existing duplicate made `CREATE UNIQUE INDEX` throw out of startup, every launch, with no in-app recovery. `dedupeMessagesByFolderUid` now runs first: duplicates are the same server message copied by the pre-constraint upsert, so it collapses each `(folder_id, uid)` to one row, keeping the row that carries the most work (AI analysis / sweep cache, then newest). It is a no-op on a healthy DB. The suite reproduces the duplicate, confirms it blocks the index, and checks dedupe fixes it and preserves the AI-carrying row.
- ~~**DB never reclaims space**~~ **Fixed** (#58) — `reclaimFreelistIfLarge` runs `VACUUM` on quit (after the window closes, so the ~2s block is invisible) when the freelist is both ≥25% of the file and ≥20MB. Self-throttling — VACUUM zeroes the freelist, so it does not run again until enough mail has been deleted to rebuild it — and skipped on small databases, where a full rewrite is not worth the churn. Measured: 315MB → 198MB on a real profile (116MB reclaimed).
- ~~**Local search full-scans the account with `LIKE` over `body_html`**~~ **Fixed** (#60) — search now scans a stored plain-text `search_text` column (text/plain, or stripped HTML) instead of the raw ~87MB of `body_html`: measured 99ms → 19ms on a real profile, and matches content not markup (a query for `div` no longer hits every `<div>`). Populated on upsert and backfilled in the background (chunked, so no startup freeze); search falls back to `body_html` for rows not yet reached, so it is correct throughout. The renderer-supplied `limit` is also clamped (≤200). **Still linear** in body size — `LIKE` cannot be indexed; a trigram FTS5 index over `search_text` would be the sub-linear next step, not taken here to avoid re-adding FTS machinery without separate justification.
- ~~**On-disk permissions are left at defaults.**~~ **Fixed** (#90) — measured on a real profile: data and attachments dirs `0775`, database `0644`. `electron/db/permissions.ts` now enforces `0700` on directories and `0600` on the database *and its `-wal`/`-shm` sidecars* (which hold the same content under WAL), applied on every start via `restrictDataDirectories()` so existing installs are corrected in place — the first cut tightened only what had been used, and a real profile came back with a `0600` database beside a `0775` attachments directory, since that path is reached only when an attachment is fetched — and only ever clearing bits so a stricter choice by the user stands. Attachment files downloaded before they were written `0600` (#42) are tightened by a guarded one-time sweep on the next launch — 1,154 of 1,156 files on the profile this was checked against — which only clears bits, records itself in `app_preferences`, and so never walks a large store twice. Raw `.eml` exports — a whole email each — moved from predictable, world-readable, never-deleted files in `/tmp` to one owner-only directory per run, removed on quit, with a startup sweep for directories left by a crashed run (ours only, and only when older than a day, so a second running copy keeps its files).
- ~~**Remote content loads unconditionally**~~ **Fixed** (#63) — remote images and CSS backgrounds (`img src`, `srcset`, `background`, `poster`, `style` `url()`) are blocked by default. `sanitizeEmailHtml(html, { blockRemoteContent })` strips them via the existing `afterSanitizeAttributes` hook (inline `data:`/`cid:` kept); `hasRemoteContent()` gates a reader bar offering **Load images** (this message) or **Always load from sender** (persisted per-sender in `imageAllowedSenders`). A global "always load remote images" toggle now exists in Settings → Privacy; the per-sender allow remains the narrower escape hatch.
- ~~**AI prompt handling trusts message content**~~ **Fixed** (#87) — sender-controlled text (body, subject, `From`) is now wrapped by `fenceUntrusted` in markers the content cannot forge (a body containing the closing marker is defanged first, so it cannot escape the fence and continue as prompt), and all four system prompts carry `UNTRUSTED_CONTENT_RULE`: the fenced region is data to describe, never instructions to follow. `isMessageFromUser` replaces four copies of `fromLower.includes(email)` with an exact match on the mailbox part — the old predicate returned true for `"you@yours" <them@theirs>`, inverting polarity everywhere the AI features use it. What remains is the model's own judgement: a draft is still generated from attacker-influenced text, so the user reviewing before sending is part of the control, and the README says so plainly.

### Low — fixed

- ~~**Deleting an account left its AI Tasks behind.**~~ **Fixed** (#56) — `sweep_tasks` has no foreign key, so the account cascade did not reach it: removing an account deleted its mail, folders and attachment files but orphaned the AI Task rows (task text, source subject, sender, source message-id — content derived from the deleted mail). `removeAccount` now deletes the account's per-folder tasks and any unified-inbox tasks tied to its messages, before the cascade drops the folders/messages the subqueries need; other accounts' unified tasks are left alone. A guarded one-time migration (#57) also clears orphans left by deletions that predate the fix — scoped to per-folder tasks whose folder is gone (the unambiguous account-deletion signature), never unified tasks whose source message merely aged out of the cache. Surfaced by a user question about account-deletion hygiene; verified against a copy of a real DB and guarded by suite checks.
- ~~**Linux launcher badge never cleared.**~~ **Fixed** (#41) — the Unity `LauncherEntry` signal was emitted on a percent-encoded object path that D-Bus rejects outright, and the failure was swallowed as "this desktop ignores Unity signals", so a badge once set could never be cleared. `app.setDesktopName` was also stripping the `.desktop` suffix Electron documents as required, leaving `setBadgeCount` pointing at a non-existent entry. In-app counts were always correct; only the launcher was stale.
- ~~Optimistic star/read/flag never rolls back in threaded view (the default), because `patchMessageInList` returns `null` when the row exists only in `selectedMessage`.~~ **Fixed** (#82) — it now also looks in the open conversation (`selectedThread`) and in inline-expanded conversations (`expandedThreadMessages`), patches every place the row appears, and keeps the collapsed row's unread dot and star in step. The audit understated it: in conversation view the patch did not apply *at all*, so a flag colour or mark-unread from the context menu on an expanded child showed nothing until the next refresh, and a rejected write left the UI asserting what the server had refused. Eight new store checks, confirmed failing before the fix.
- ~~`selectThread` has no error handling — a failed fetch pins "Loading conversation…" forever and rejects into a `void` call; milder in `selectMessage`.~~ **Fixed** (#83) — both opens now catch, stop their loading flag, and record a `readerError` carrying the message and what to retry; the reader shows it with a **Try again** button (`retryReaderLoad`) instead of an empty state that reads as "nothing selected". The row stays selected, and the error clears on the next selection or a folder/view switch so it cannot outlive what it was about. Guarded by store checks — against the pre-fix store the rejection escapes and takes the whole run down, which is what a `void` call did with it in the app.
- ~~Thread mutations (`deleteThread`, `archiveThread`, `moveThreadToFolder`) test a pre-`await` state snapshot, so the reader can keep showing a deleted conversation.~~ **Fixed** (#73, pinned in #85) — the selection test moved into `removeThreadAndAdvance`, which re-reads state, when the bulk actions were factored onto one spine; it was fixed incidentally there and nothing pinned it, so #85 added the checks (a delete landing after the user has opened that conversation clears the reader; one landing after they have moved elsewhere does not steal it) and confirmed they fail against a re-introduced snapshot check. #85 also removed the same idiom from the twelve remaining `store.folders` reads, which were taken before an await, via `currentFolders()`.
- ~~Compose sends the original message's **unsanitized** HTML in the quote block~~ **Fixed** (#69) — `src/components/compose/ComposeWindow.tsx` now runs the quoted original through `sanitizeEmailHtml(..., { blockRemoteContent: true })` when it is set, so both the compose preview and the sent body share one safe copy: the sender's scripts/navigation sinks are stripped, and their remote trackers no longer ride into the reply or the Sent folder (matching how #63 renders remote content).
- ~~Attachments sharing a filename overwrite each other on disk.~~ **Fixed** (#42) — the cache path is keyed by attachment id, and files are written 0600. The audit only spotted the on-disk half: an end-to-end test then showed *both* rows also resolved to the same MIME part, so the second attachment's content was never fetched at all. Attachments are identified by `(filename, size)`, but BODYSTRUCTURE reports encoded octets while the stored size is mailparser's decoded length, so the size rarely matches and both fell back to "first part with this name". Now disambiguated by position, which is how the rows are created.
- ~~Accounts dedupe by email alone (`db-service.ts:38-41`), so adding a manual account overwrites an existing OAuth one in place.~~ **Fixed** (#84) — a re-add still updates in place when the provider matches (that is re-authentication and password changes), but a *provider switch* is refused with a message naming both providers and the way out (remove the account first, which is also the path that cleans up its mail). The overwrite replaced the stored credentials — an OAuth refresh token is unrecoverable afterwards — and left already-synced mail attached to an account that now behaved as plain IMAP. Deliberately not addressed: address matching is still case-sensitive, so `Rob@x` and `rob@x` remain two accounts.
- ~~Renderer-supplied `attachmentPaths` are `readFileSync`'d with no allowlist (`smtp-send.ts:125-130`); the main process should track dialog-approved paths instead of trusting the renderer.~~ **Fixed** (#86) — `attachment-allowlist.ts` approves a path only from the OS file dialog, a genuine drag-and-drop (resolved by `webUtils.getPathForFile` in the preload, which yields nothing for a `File` the renderer constructs, so the renderer never names a path), or main itself for the raw `.eml` it writes for forward-as-attachment. Paths arriving via `compose.open` are deliberately not approved — the renderer can call that freely. `sendMail` asserts before any credential or transport work, `compose:statAttachments` answers only for approved paths (size and existence leak on their own), and approval is cleared when the compose window closes. The end-to-end check — a send naming `/etc/passwd` — was confirmed passing without the assert and refused with it.
- ~~`buildLikePattern` leaves `_` as a live LIKE wildcard~~ **Fixed** (#70) — `\w` keeps the underscore, so a search for `foo_bar` also matched `fooXbar`. The pattern builder now backslash-escapes `\`, `_` and `%`, and every LIKE in `searchMessages` carries `ESCAPE '\'`, so a typed `_` matches a literal underscore. The suite asserts `foo_bar` hits the literal row but not `fooXbar`. (The former companion finding here, `SEARCH_FIELD_COLUMNS['constructor']`, was stale — that symbol no longer exists.)
- ~~Flag reconciliation holds the account's connection lane across every folder.~~ **Fixed** (#34) — `reconcileAccountFlags` now borrows the pooled client per folder, so an interactive op waits for one folder rather than the whole pass. Observed in a dev run as `[ipc-slow] messages:markRead 6288ms`; the integration suite reproduces it at 2995ms vs 312ms fixed.

### Checked and clean

No `rejectUnauthorized: false` anywhere. No SQL injection (every dynamic fragment is placeholder generation; no dynamic column/table names). No SMTP header injection (nodemailer strips CR/LF — verified directly). No attachment path traversal. No schema drift between `schema.ts`, `CREATE TABLE`, and `migrateSchema`. AI cache columns correctly survive sync upserts. The print path is sound: escaped interpolation, sanitized body, hidden window with `javascript: false`, `sandbox: true`, no preload. Renderer listener/interval cleanup is correct throughout.

## Performance work already done

- Startup reorder — register IPC + show the window first, then defer background IMAP network (IDLE + polling) until after first paint, with an immediate catch-up sync on launch.
- Bundle slimming — deep per-icon Phosphor imports (ssr variants) and a vendor/react-vendor `manualChunks` split so app-code updates don't invalidate vendor chunks.
- IDLE-aware poll — POP3 polls every 20s; IDLE-capable IMAP accounts poll every 90s (IDLE push-syncs their inboxes).
- ~~Hoisted the hot FTS index statements (run per message during sync) to module scope.~~ **Moot** — the FTS index was removed entirely in #36 (it was write-only), taking those statements with it.
