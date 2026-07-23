import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

// System tray indicator.
//
// This exists because the launcher badge is invisible on some desktops:
// Cinnamon's window-list applet implements no Unity `LauncherEntry` support, so
// the count signal is emitted and ignored (see app-badge.ts). A tray icon goes
// through a different channel — StatusNotifierItem, which Mint bridges to the
// panel via xapp-sn-watcher — and is drawn by the panel itself.
//
// The count has to live *in the image*: Electron's Tray offers no text label on
// Linux (`setTitle` is macOS-only), so `npm run icons` pre-renders one PNG per
// count and this module swaps between them.

/**
 * Icon file for a count. Anything above nine collapses to "9+" — two digits are
 * unreadable at panel size — and zero, negatives and junk fall back to the plain
 * icon rather than rendering a badge that means nothing.
 */
export function trayIconFile(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'tray.png'
  const whole = Math.floor(count)
  return whole > 9 ? 'tray-9plus.png' : `tray-${whole}.png`
}

/** Tooltip text — the only place the exact count survives past nine. */
export function trayTooltip(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return 'Orbit Mail'
  const whole = Math.floor(count)
  return `Orbit Mail — ${whole} unread message${whole === 1 ? '' : 's'}`
}

// Mirrors getAppIconPath's search: packaged resources first, then the repo.
function trayIconPath(file: string): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icons/tray', file),
    join(app.getAppPath(), 'build/icons/tray', file),
    join(__dirname, '../../build/icons/tray', file),
    join(__dirname, '../build/icons/tray', file)
  ]
  return candidates.find((path) => existsSync(path))
}

let tray: Tray | null = null
let lastIconFile: string | null = null

function showWindow(getWindow: () => BrowserWindow | null): void {
  const window = getWindow()
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

export function initTray(getWindow: () => BrowserWindow | null): void {
  // Linux-only, like the rest of the desktop integration. Elsewhere the dock
  // badge already carries the count.
  if (process.platform !== 'linux' || tray) return

  const iconPath = trayIconPath('tray.png')
  if (!iconPath) {
    console.warn('[orbit-mail] Tray icon missing — run `npm run icons`. Skipping tray.')
    return
  }

  tray = new Tray(nativeImage.createFromPath(iconPath))
  lastIconFile = 'tray.png'
  tray.setToolTip(trayTooltip(0))
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Orbit Mail', click: () => showWindow(getWindow) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  // Some panels deliver a plain click, others only the menu; wire both.
  tray.on('click', () => showWindow(getWindow))
}

export function updateTrayUnread(count: number): void {
  if (!tray) return

  tray.setToolTip(trayTooltip(count))

  const file = trayIconFile(count)
  // Swapping the image on every sync makes some panels flicker; only redraw
  // when the count actually crosses into a different icon.
  if (file === lastIconFile) return
  const path = trayIconPath(file)
  if (!path) return
  tray.setImage(nativeImage.createFromPath(path))
  lastIconFile = file
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
  lastIconFile = null
}
