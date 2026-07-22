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

export function saveUiPreferencesNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  void window.orbitMail.preferences.saveUi(getUiSnapshot())
}

export function exposeFlushHook(): void {
  window.__orbitMailFlush = saveUiPreferencesNow
}

declare global {
  interface Window {
    __orbitMailFlush?: () => void
  }
}
