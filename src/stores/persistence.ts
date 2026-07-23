import type { UiPreferences } from '../../shared/types'
import { useThemeStore } from './themeStore'
import { useMailStore } from './mailStore'

let saveTimer: ReturnType<typeof setTimeout> | null = null

export function getUiSnapshot(): UiPreferences {
  const mail = useMailStore.getState()
  return {
    darkMode: useThemeStore.getState().darkMode,
    selectedFolderId: mail.selectedFolderId,
    selectedMessageId: mail.selectedMessageId,
    collapsedAccountIds: mail.collapsedAccountIds,
    favoriteFolderIds: mail.favoriteFolderIds,
    threadedView: mail.threadedView,
    unreadFilterByAccount: mail.unreadFilterByAccount,
    searchField: mail.searchField
  }
}

export function applyUiPreferences(ui: UiPreferences): void {
  useThemeStore.getState().setDarkMode(ui.darkMode, { persist: false })
  useMailStore.setState({
    selectedFolderId: ui.selectedFolderId,
    selectedMessageId: ui.selectedMessageId,
    collapsedAccountIds: ui.collapsedAccountIds,
    favoriteFolderIds: ui.favoriteFolderIds,
    threadedView: ui.threadedView,
    unreadFilterByAccount: ui.unreadFilterByAccount ?? {},
    searchField: ui.searchField ?? 'all'
  })
}

export async function loadPersistedPreferences(): Promise<void> {
  const state = await window.orbitMail.preferences.get()
  applyUiPreferences(state.ui)
  useMailStore.getState().setImageAllowedSenders(state.imageAllowedSenders ?? [])
}

export function scheduleSaveUiPreferences(patch?: Partial<UiPreferences>): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    const ui = { ...getUiSnapshot(), ...patch }
    void window.orbitMail.preferences.saveUi(ui)
  }, 250)
}

/**
 * Persist immediately, and **return the promise**. Quit awaits this: it used to
 * be fire-and-forget, so even a main process that waited for the flush call to
 * return could still exit before the IPC behind it had landed.
 */
export async function saveUiPreferencesNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  await window.orbitMail.preferences.saveUi(getUiSnapshot())
}

export function exposeFlushHook(): void {
  window.__orbitMailFlush = saveUiPreferencesNow
}

declare global {
  interface Window {
    // Returns a promise so `executeJavaScript` resolves only once the write has
    // actually happened, not merely once it has been asked for.
    __orbitMailFlush?: () => Promise<void>
  }
}
