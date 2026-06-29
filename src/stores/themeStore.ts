import { create } from 'zustand'
import { scheduleSaveUiPreferences } from './persistence'

function readInitialDarkMode(): boolean {
  try {
    return localStorage.getItem('orbit-mail-dark-mode') === 'true'
  } catch {
    return false
  }
}

export function applyTheme(darkMode: boolean): void {
  document.documentElement.dataset.theme = darkMode ? 'dark' : 'light'
}

interface ThemeState {
  darkMode: boolean
  setDarkMode: (darkMode: boolean, options?: { persist?: boolean }) => void
  toggleDarkMode: () => void
}

export const useThemeStore = create<ThemeState>((set) => ({
  darkMode: readInitialDarkMode(),
  setDarkMode: (darkMode, options = { persist: true }) => {
    applyTheme(darkMode)
    try {
      localStorage.setItem('orbit-mail-dark-mode', String(darkMode))
    } catch {
      // ignore storage errors
    }
    set({ darkMode })
    if (options.persist !== false) {
      scheduleSaveUiPreferences({ darkMode })
    }
  },
  toggleDarkMode: () => {
    useThemeStore.getState().setDarkMode(!useThemeStore.getState().darkMode)
  }
}))
