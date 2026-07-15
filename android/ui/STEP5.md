# Compose UI (Plan Step 5)

Inbox list → thread reader → compose/send → search, in Jetpack Compose (audit §1
stack), with the bug-prone UI *logic* extracted to a pure module and verified
off-device.

## What's here

| Path | Role | Built here? |
|---|---|---|
| `presentation/` | **UI logic, pure Kotlin**: UiState + reducer (optimistic updates), reply/reply-all/forward composition, formatting, search | ✅ `gradle test` (9/9) |
| `compose/` | **The real Compose UI**: screens, ViewModels, theme, nav, manifest | ❌ (Compose + AndroidX on Google Maven; no Android SDK — both blocked) |

This is the step the sandbox constrains most — Compose can't render here. So the
value is concentrated where it's verifiable: the state machine behind the pixels.
The ViewModels are thin wrappers that hold the verified logic in a `StateFlow`.

## Verified here (`presentation`, `gradle test`, 9/9)

| Proof | Confirms |
|---|---|
| `optimisticStar_thenRollback_restoresPriorState` | Star applies instantly; a failed backing call restores the exact prior state (the `patchMessageInList` + rollback pattern, audit §Performance) |
| `markRead_patchesOnlyTargetRow` | Optimistic patch touches only the target row |
| `remove_advancesSelectionToNextRow` | Delete/move advances selection to next row (else previous) — reader doesn't blank |
| `unreadFilter_and_mergeRefresh` | Unread filter derived; a background refresh drops a vanished selection |
| `reply_setsRecipientSubjectAndReferencesChain` | To=sender, `Re:` subject, RFC References chain = prior refs + parent Message-ID |
| `replyAll_dedupesExcludesSelfAndSender` | Cc = (To ∪ Cc) − self − sender, de-duplicated, order preserved |
| `replySubject_notDoubledWhenAlreadyRe` | `Re:`/`Fwd:` not stacked |
| `mailFormat_names_dates_sizes` | Sender display names, compact list dates (time/weekday/date), byte sizes |
| `searchState_scopeAndLikePattern` | Scope + LIKE pattern (space→wildcard, sanitized) matching the Step 2 DAO |

## The real Compose UI (deferred build — `compose/`)

- **ViewModels** — `InboxViewModel` (StateFlow<InboxUiState>, optimistic mutations
  with rollback via the verified `InboxReducer`), `ReaderViewModel` (loads the
  cross-folder conversation; reply/replyAll/forward via `ReplyComposer`),
  `ComposeViewModel` (draft editing + send).
- **Screens** — `InboxListScreen` (LazyColumn keyed by id → minimal recomposition
  on Room's reactive refresh), `ThreadReaderScreen` (stacked conversation +
  Reply/Reply All/Forward), `ComposeScreen` (To/Cc/Subject/Body + Send),
  `OrbitApp` (nav across the four flows), `OrbitTheme` (light/dark + dynamic
  color), `MainActivity`, manifest (launcher + `mailto:` + foreground-service
  permissions for Step 6 IDLE).
- **`MailUiRepository`** — the port the ViewModels depend on; the app implements
  it over the Step 2 Room DAOs (reactive `Flow` reads + mutations), the Step 4
  sync engine (refresh), and SMTP send.

## How it wires to the other steps

- **Step 2:** `MailUiRepository.observeMessageRows/observeThreadRows` map to the
  DAO `Flow` queries (list/threads); mutations to the DAO writes. Room `Flow` is
  what makes the list reactive (audit §4).
- **Step 3:** `selfAddresses` (for reply-all exclusion) comes from the signed-in
  accounts; send uses the freshAccessToken path.
- **Step 4:** `refresh()` calls the sync engine; new mail flows back through Room
  `Flow` into `mergeRefresh`.

## Deferred (needs the Android app project)

- Compose compile + render / screenshot / UI tests (Compose UI test, Paparazzi).
  The logic behind each screen is verified above; rendering is a device concern.
- HTML body rendering (sanitized HTML in a JS-disabled WebView — audit
  §print/security), rich-text compose editor, attachment chips, swipe actions,
  the full search results screen (reuses `InboxListScreen` over
  `MailUiRepository.search`).
- DI wiring in `MainActivity` (sketched in comments).

## Run the verification

```bash
cd android/ui/presentation
gradle test      # 9 passed
```
