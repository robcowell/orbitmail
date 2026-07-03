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
  app.setDesktopName(LINUX_DESKTOP_ENTRY_ID.replace(/\.desktop$/, ''))
}
