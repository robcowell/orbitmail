import { execFile } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { promisify } from 'util'
import { totalUnreadCount } from '../shared/folders'
import { listAccounts, listFolders } from './services/db-service'
import { LINUX_DESKTOP_ENTRY_ID } from './app-icon'

const execFileAsync = promisify(execFile)

const APP_URI = `application://${LINUX_DESKTOP_ENTRY_ID}`

/**
 * D-Bus object path for the Unity LauncherEntry signal.
 *
 * A D-Bus object path may only contain `[A-Za-z0-9_]` between slashes, so the
 * app URI cannot be embedded in it. Percent-encoding it — which is what this
 * used to do — produces `…/application%3A%2F%2Forbit-mail.desktop`, which gdbus
 * rejects outright with "is not a valid object path". Every emit failed, the
 * error was swallowed as an environment quirk, and a badge once set could never
 * be cleared.
 *
 * The URI identifies the app in the signal payload; the path only has to be
 * valid, unique and stable, so derive it from the URI as a number.
 */
export function unityObjectPath(appUri: string = APP_URI): string {
  let hash = 0
  for (let i = 0; i < appUri.length; i++) {
    hash = (hash * 31 + appUri.charCodeAt(i)) >>> 0
  }
  return `/com/canonical/unity/launcherentry/${hash}`
}

/** The `a{sv}` payload for the LauncherEntry Update signal. `count` is int64. */
export function unityBadgeProperties(count: number): string {
  return count > 0
    ? `{'count': <int64 ${count}>, 'count-visible': <true>}`
    : `{'count': <int64 0>, 'count-visible': <false>}`
}

function computeUnreadTotal(): number {
  return totalUnreadCount(listAccounts(), listFolders())
}

async function updateUnityLauncherBadge(count: number): Promise<void> {
  if (process.platform !== 'linux') return

  const properties = unityBadgeProperties(count)

  try {
    await execFileAsync('gdbus', [
      'emit',
      '--session',
      '--object-path',
      unityObjectPath(),
      '--signal',
      'com.canonical.Unity.LauncherEntry.Update',
      APP_URI,
      properties
    ])
  } catch (err) {
    // A desktop that ignores Unity signals is expected (setBadgeCount is tried
    // separately), but a malformed emit is a bug — don't let it hide again.
    const message = err instanceof Error ? err.message : String(err)
    if (/not a valid object path|Invalid|malformed/i.test(message)) {
      console.warn('[orbit-mail] Launcher badge emit was rejected as malformed:', message)
    }
  }
}

export function updateAppBadge(mainWindow: BrowserWindow | null): void {
  const count = computeUnreadTotal()

  if (process.platform === 'darwin' || process.platform === 'linux') {
    app.setBadgeCount(count)
  }

  void updateUnityLauncherBadge(count)

  const title = count > 0 ? `Orbit Mail (${count})` : 'Orbit Mail'
  mainWindow?.setTitle(title)
}
