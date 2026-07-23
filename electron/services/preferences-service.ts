import type { SearchField } from '../../shared/types'
import { getRawSqlite } from '../db'

const PREFERENCES_KEY = 'app_state'

export interface UiPreferences {
  darkMode: boolean
  selectedFolderId: string | 'unified'
  selectedMessageId: string | null
  collapsedAccountIds: Record<string, boolean>
  favoriteFolderIds: string[]
  threadedView: boolean
  unreadFilterByAccount: Record<string, boolean>
  searchField: SearchField
}

export interface WindowPreferences {
  width: number
  height: number
  x?: number
  y?: number
}

export interface PersistedAppState {
  ui: UiPreferences
  lastSyncAt: number | null
  handleMailtoLinks?: boolean
  window?: WindowPreferences
  mutedSenders?: string[]
  blockedSenders?: string[]
  imageAllowedSenders?: string[]
}

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
      handleMailtoLinks: parsed.handleMailtoLinks ?? false,
      mutedSenders: parsed.mutedSenders ?? [],
      blockedSenders: parsed.blockedSenders ?? [],
      imageAllowedSenders: parsed.imageAllowedSenders ?? [],
      window: parsed.window
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

export function patchAppState(patch: Partial<PersistedAppState>): PersistedAppState {
  const current = getAppState()
  const next: PersistedAppState = {
    ...current,
    ...patch,
    ui: { ...current.ui, ...patch.ui },
    handleMailtoLinks: patch.handleMailtoLinks ?? current.handleMailtoLinks ?? false,
    mutedSenders: patch.mutedSenders ?? current.mutedSenders ?? [],
    blockedSenders: patch.blockedSenders ?? current.blockedSenders ?? [],
    imageAllowedSenders: patch.imageAllowedSenders ?? current.imageAllowedSenders ?? []
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

export function setWindowPreferences(window: WindowPreferences | undefined): void {
  patchAppState({ window })
}

export function getWindowPreferences(): WindowPreferences | undefined {
  return getAppState().window
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
