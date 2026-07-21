import { app } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'

export const LINUX_DESKTOP_ENTRY_ID = 'orbit-mail.desktop'

export function getAppIconPath(): string | undefined {
  const candidates = [
    join(process.resourcesPath, 'icons/256x256.png'),
    join(process.resourcesPath, 'icons/512x512.png'),
    join(app.getAppPath(), 'build/icons/256x256.png'),
    join(app.getAppPath(), 'build/icons/512x512.png'),
    join(__dirname, '../../build/icons/256x256.png'),
    join(__dirname, '../build/icons/256x256.png')
  ]

  return candidates.find((path) => existsSync(path))
}

export function configureLinuxDesktopIntegration(): void {
  if (process.platform !== 'linux') return
  app.commandLine.appendSwitch('class', 'orbit-mail')
  // Electron wants the *.desktop file name here, suffix included — its docs for
  // the Linux badge/progress APIs say to "specify the `*.desktop` file name".
  // Stripping it, as this used to, pointed libunity at an entry that does not
  // exist, so setBadgeCount had nothing to attach to or clear.
  app.setDesktopName(LINUX_DESKTOP_ENTRY_ID)
}
