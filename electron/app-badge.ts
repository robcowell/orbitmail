import { execFile } from 'child_process'
import { app, BrowserWindow } from 'electron'
import { promisify } from 'util'
import { totalUnreadCount } from '../shared/folders'
import { listAccounts, listFolders } from './services/db-service'
import { LINUX_DESKTOP_ENTRY_ID } from './app-icon'

const execFileAsync = promisify(execFile)

const APP_URI = `application://${LINUX_DESKTOP_ENTRY_ID}`
const UNITY_OBJECT_PATH = `/com/canonical/Unity/LauncherEntry/${encodeURIComponent(APP_URI)}`

function computeUnreadTotal(): number {
  return totalUnreadCount(listAccounts(), listFolders())
}

async function updateUnityLauncherBadge(count: number): Promise<void> {
  if (process.platform !== 'linux') return

  const properties =
    count > 0
      ? `{'count': <${count}>, 'count-visible': <true>}`
      : `{'count': <0>, 'count-visible': <false>}`

  try {
    await execFileAsync('gdbus', [
      'emit',
      '--session',
      '--object-path',
      UNITY_OBJECT_PATH,
      '--signal',
      'com.canonical.Unity.LauncherEntry.Update',
      APP_URI,
      properties
    ])
  } catch {
    // Cinnamon/Plasma may ignore Unity signals; setBadgeCount is tried separately.
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
