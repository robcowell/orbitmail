// The types live in shared/types.ts and are imported, not re-declared. They used
// to be written out again here, and the two copies had already drifted — the
// sender arrays were required in one and optional in the other, so main and the
// renderer disagreed about whether they could be absent.
import type {
  ComposeWindowPreferences,
  PersistedAppState,
  UiPreferences,
  WindowPreferences
} from '../../shared/types'
import { getRawSqlite } from '../db'

export type { ComposeWindowPreferences, PersistedAppState, UiPreferences, WindowPreferences }

const PREFERENCES_KEY = 'app_state'

export const DEFAULT_UI_PREFERENCES: UiPreferences = {
  darkMode: false,
  selectedFolderId: 'unified',
  selectedMessageId: null,
  collapsedAccountIds: {},
  favoriteFolderIds: [],
  threadedView: true,
  unreadFilterByAccount: {},
  searchField: 'all'
}

export const DEFAULT_APP_STATE: PersistedAppState = {
  ui: DEFAULT_UI_PREFERENCES,
  lastSyncAt: null,
  handleMailtoLinks: false,
  // The two true-by-default flags describe what the app already did before
  // there was a switch, so an existing install behaves identically until the
  // user touches one.
  closeToTray: true,
  desktopNotifications: true,
  alwaysLoadRemoteImages: false,
  mutedSenders: [],
  blockedSenders: [],
  imageAllowedSenders: []
}

function readRawState(): PersistedAppState {
  const db = getRawSqlite()
  const row = db
    .prepare('SELECT value FROM app_preferences WHERE key = ?')
    .get(PREFERENCES_KEY) as { value: string } | undefined

  if (!row) return { ...DEFAULT_APP_STATE, ui: { ...DEFAULT_UI_PREFERENCES } }

  try {
    const parsed = JSON.parse(row.value) as Partial<PersistedAppState>
    return {
      ui: { ...DEFAULT_UI_PREFERENCES, ...parsed.ui },
      lastSyncAt: parsed.lastSyncAt ?? null,
      accountLastSyncAt: parsed.accountLastSyncAt ?? {},
      handleMailtoLinks: parsed.handleMailtoLinks ?? false,
      closeToTray: parsed.closeToTray ?? true,
      desktopNotifications: parsed.desktopNotifications ?? true,
      alwaysLoadRemoteImages: parsed.alwaysLoadRemoteImages ?? false,
      mutedSenders: parsed.mutedSenders ?? [],
      blockedSenders: parsed.blockedSenders ?? [],
      imageAllowedSenders: parsed.imageAllowedSenders ?? [],
      // Left as read: `resolveAiModel`/`resolveAiEffort` do the validating at
      // the point of use, so an unrecognised value here is inert rather than
      // silently rewritten to the default behind the user's back.
      aiModel: parsed.aiModel,
      aiEffort: parsed.aiEffort,
      aiDetail: parsed.aiDetail,
      // These three were missing, and the omission is silent *data loss* rather
      // than a stale default: this literal is the whole state, so a key with no
      // line here is dropped on read, and the next patchAppState writes the blob
      // back without it. Zoom did not survive a restart, "Always include
      // attachments" turned itself back off, and Brief reverted to Full — all
      // three shipped that way. `test:imap` now fails if any optional key of
      // PersistedAppState has no line in this function, because the next one
      // added would have gone the same way.
      zoomLevel: parsed.zoomLevel,
      alwaysIncludeAttachments: parsed.alwaysIncludeAttachments ?? false,
      window: parsed.window,
      composeWindow: parsed.composeWindow
    }
  } catch {
    return { ...DEFAULT_APP_STATE, ui: { ...DEFAULT_UI_PREFERENCES } }
  }
}

let cachedState: PersistedAppState | null = null
// What is actually on disk, so an unchanged save can skip the write.
let persistedJson: string | null = null
let writes = 0

function writeRawState(state: PersistedAppState): void {
  const json = JSON.stringify(state)
  // Everything lives in one blob, so selecting a message rewrites the sender
  // allowlists too. The debounced UI save fires on selection changes that often
  // change nothing at all, so compare before writing.
  if (json === persistedJson) return

  getRawSqlite()
    .prepare(
      `INSERT INTO app_preferences (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(PREFERENCES_KEY, json)
  persistedJson = json
  writes++
}

/**
 * The persisted state.
 *
 * Returns a **copy**: this used to hand out the cached object itself, so a
 * caller mutating what it got — pushing to `mutedSenders`, say — silently
 * changed the in-memory state without persisting it, leaving memory and disk
 * disagreeing until the next write made the drift permanent.
 */
export function getAppState(): PersistedAppState {
  if (!cachedState) {
    cachedState = readRawState()
    persistedJson = JSON.stringify(cachedState)
  }
  return structuredClone(cachedState)
}

export function saveAppState(state: PersistedAppState): void {
  cachedState = structuredClone(state)
  writeRawState(state)
}

/** Test seam: how many times state has actually reached the database. */
export function appStateWriteCount(): number {
  return writes
}

/**
 * Test seam: drop the cache so the next read comes from the database.
 *
 * The upgrade path — an `app_state` blob written before a setting existed — can
 * only be exercised by writing such a blob directly and reading it back, and the
 * cache would otherwise serve the state from before that write.
 */
export function resetPreferencesCacheForTests(): void {
  cachedState = null
  persistedJson = null
}

export function patchAppState(patch: Partial<PersistedAppState>): PersistedAppState {
  const current = getAppState()
  const next: PersistedAppState = {
    ...current,
    ...patch,
    ui: { ...current.ui, ...patch.ui },
    handleMailtoLinks: patch.handleMailtoLinks ?? current.handleMailtoLinks ?? false,
    // `??` and not `||`: these are booleans and arrays where the falsy value is
    // a legitimate setting. `false || true` is true, so `||` here would make
    // every one of these impossible to turn off, and an emptied sender list
    // would spring back to its previous contents.
    closeToTray: patch.closeToTray ?? current.closeToTray ?? true,
    desktopNotifications: patch.desktopNotifications ?? current.desktopNotifications ?? true,
    alwaysIncludeAttachments:
      patch.alwaysIncludeAttachments ?? current.alwaysIncludeAttachments ?? false,
    alwaysLoadRemoteImages:
      patch.alwaysLoadRemoteImages ?? current.alwaysLoadRemoteImages ?? false,
    mutedSenders: patch.mutedSenders ?? current.mutedSenders ?? [],
    blockedSenders: patch.blockedSenders ?? current.blockedSenders ?? [],
    imageAllowedSenders: patch.imageAllowedSenders ?? current.imageAllowedSenders ?? [],
    aiModel: patch.aiModel ?? current.aiModel,
    aiEffort: patch.aiEffort ?? current.aiEffort,
    aiDetail: patch.aiDetail ?? current.aiDetail
  }
  saveAppState(next)
  return next
}

export function patchUiPreferences(patch: Partial<UiPreferences>): UiPreferences {
  const current = getAppState()
  const ui = { ...current.ui, ...patch }
  saveAppState({ ...current, ui })
  return ui
}

export function setLastSyncAt(lastSyncAt: number | null): void {
  patchAppState({ lastSyncAt })
}

export function getLastSyncAt(): number | null {
  return getAppState().lastSyncAt
}

export function getAccountLastSyncAt(): Record<string, number> {
  return getAppState().accountLastSyncAt ?? {}
}

export function setAccountLastSyncAt(accountId: string, lastSyncAt: number): void {
  // Merged rather than replaced: patchAppState shallow-merges, so writing a
  // one-key object here would drop every other account's timestamp.
  patchAppState({
    accountLastSyncAt: { ...getAccountLastSyncAt(), [accountId]: lastSyncAt }
  })
}

/** Forget a removed account's timestamp so the map does not grow forever. */
export function clearAccountLastSyncAt(accountId: string): void {
  const rest = { ...getAccountLastSyncAt() }
  if (!(accountId in rest)) return
  delete rest[accountId]
  patchAppState({ accountLastSyncAt: rest })
}

export function setWindowPreferences(window: WindowPreferences | undefined): void {
  patchAppState({ window })
}

export function getWindowPreferences(): WindowPreferences | undefined {
  return getAppState().window
}

export function setComposeWindowPreferences(composeWindow: ComposeWindowPreferences): void {
  patchAppState({ composeWindow })
}

export function getComposeWindowPreferences(): ComposeWindowPreferences | undefined {
  return getAppState().composeWindow
}

export function setZoomLevel(zoomLevel: number): void {
  patchAppState({ zoomLevel })
}

export function getZoomLevel(): number {
  return getAppState().zoomLevel ?? 0
}

function normalizeEmail(email: string): string {
  const match = email.match(/<([^>]+)>/)
  return (match ? match[1] : email).trim().toLowerCase()
}

export function allowSenderImages(email: string): void {
  const normalized = normalizeEmail(email)
  if (!normalized) return
  const current = getAppState()
  if (current.imageAllowedSenders?.includes(normalized)) return
  patchAppState({ imageAllowedSenders: [...(current.imageAllowedSenders ?? []), normalized] })
}

export function muteSender(email: string): void {
  const normalized = normalizeEmail(email)
  if (!normalized) return
  const current = getAppState()
  if (current.mutedSenders?.includes(normalized)) return
  patchAppState({ mutedSenders: [...(current.mutedSenders ?? []), normalized] })
}

export function blockSender(email: string): void {
  const normalized = normalizeEmail(email)
  if (!normalized) return
  const current = getAppState()
  if (current.blockedSenders?.includes(normalized)) return
  patchAppState({ blockedSenders: [...(current.blockedSenders ?? []), normalized] })
}

// Removal. Each returns the resulting list so a caller can update its own copy
// without a second read. Entries were normalized on the way in, so the address
// is normalized here too — otherwise "Bob <BOB@x>" could never remove "bob@x".

function withoutSender(list: string[] | undefined, email: string): string[] {
  const normalized = normalizeEmail(email)
  return (list ?? []).filter((entry) => entry !== normalized)
}

export function unmuteSender(email: string): string[] {
  const next = withoutSender(getAppState().mutedSenders, email)
  patchAppState({ mutedSenders: next })
  return next
}

export function unblockSender(email: string): string[] {
  const next = withoutSender(getAppState().blockedSenders, email)
  patchAppState({ blockedSenders: next })
  return next
}

export function revokeSenderImages(email: string): string[] {
  const next = withoutSender(getAppState().imageAllowedSenders, email)
  patchAppState({ imageAllowedSenders: next })
  return next
}

/**
 * Whether a sender is blocked or muted. Both take a raw `From` header and
 * compare the mailbox part, never the display name — the display name is
 * attacker-controlled, so `"blocked@x" <attacker@y>` must not read as blocked
 * (and, worse, `"trusted@x" <blocked@y>` must not read as unblocked).
 *
 * These read the cache directly rather than through `getAppState()`: that clones
 * the whole blob on every call, and sync asks this question once per message.
 */
function currentState(): PersistedAppState {
  if (!cachedState) {
    cachedState = readRawState()
    persistedJson = JSON.stringify(cachedState)
  }
  return cachedState
}

export function isSenderBlocked(from: string): boolean {
  const normalized = normalizeEmail(from)
  return !!normalized && (currentState().blockedSenders ?? []).includes(normalized)
}

export function isSenderMuted(from: string): boolean {
  const normalized = normalizeEmail(from)
  return !!normalized && (currentState().mutedSenders ?? []).includes(normalized)
}

/** The blocked addresses themselves, for building a query predicate. */
export function getBlockedSenders(): string[] {
  return currentState().blockedSenders ?? []
}
