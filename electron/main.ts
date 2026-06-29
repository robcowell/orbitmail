import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, dialog, Notification } from 'electron'
import { join } from 'path'
import type { ComposePayload, SyncStatus, ManualAccountInput } from '../shared/types'
import { configureLinuxDesktopIntegration, getAppIconPath } from './app-icon'
import {
  listAccounts,
  saveAccount,
  removeAccount,
  listFolders,
  listMessages,
  countMessages,
  getMessage,
  setMessageRead,
  setMessageStarred,
  deleteMessage,
  getFolderById,
  searchMessages,
  getAttachment
} from './services/db-service'
import { authenticateGoogle } from './services/oauth-google'
import { authenticateMicrosoft } from './services/oauth-microsoft'
import {
  refreshAllAccounts,
  getSyncStatus,
  onSyncStatusChange,
  startBackgroundSync,
  stopBackgroundSync,
  markMessageReadOnServer,
  toggleMessageStarredOnServer,
  deleteMessageOnServer,
  moveMessageOnServer,
  refreshAccount,
  pollForNewMessages,
  setOnFolderSynced,
  setOnNewMailArrived,
  initSyncFromPersistence
} from './services/imap-sync'
import {
  startIdleMonitoring,
  stopIdleMonitoring,
  restartIdleMonitoring,
  setIdleNewMailHandler
} from './services/imap-idle'
import { sendMail, buildReplyPayload } from './services/smtp-send'
import { autodetectMailSettings } from './services/mail-autoconfig'
import { addManualAccount } from './services/manual-account'
import {
  getAppState,
  patchAppState,
  patchUiPreferences,
  setWindowPreferences,
  getWindowPreferences
} from './services/preferences-service'

let mainWindow: BrowserWindow | null = null
let composeWindow: BrowserWindow | null = null
let lastNotificationAt = 0

configureLinuxDesktopIntegration()

function getWindowIcon(): string | undefined {
  return getAppIconPath()
}

function parseMailtoUrl(url: string): Partial<ComposePayload> {
  try {
    const parsed = new URL(url)
    const to = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''))
    const subject = parsed.searchParams.get('subject') ?? ''
    const body = parsed.searchParams.get('body') ?? ''
    const cc = parsed.searchParams.get('cc') ?? ''
    const bcc = parsed.searchParams.get('bcc') ?? ''

    return {
      to,
      cc: cc || undefined,
      bcc: bcc || undefined,
      subject,
      bodyText: body,
      bodyHtml: body ? `<p>${body.replace(/\n/g, '<br>')}</p>` : ''
    }
  } catch {
    return {}
  }
}

function enrichComposePayload(payload?: Partial<ComposePayload>): Partial<ComposePayload> {
  if (!payload) return {}

  if (payload.originalMessageId && payload.mode) {
    const accountId =
      payload.accountId ??
      getMessage(payload.originalMessageId)?.accountId ??
      listAccounts()[0]?.id ??
      ''
    return {
      ...buildReplyPayload(payload.originalMessageId, accountId, payload.mode),
      ...payload,
      accountId: payload.accountId ?? accountId
    }
  }

  return payload
}

function openComposeFromMailto(url: string): void {
  const accounts = listAccounts()
  const mailtoPayload = parseMailtoUrl(url)
  const accountId = accounts[0]?.id

  if (!accountId) {
    mainWindow?.webContents.send('app:needsAccount')
    return
  }

  createComposeWindow({ accountId, ...mailtoPayload })
  mainWindow?.show()
  mainWindow?.focus()
}

function showNewMailNotification(count: number): void {
  if (!Notification.isSupported()) return
  if (Date.now() - lastNotificationAt < 5000) return
  lastNotificationAt = Date.now()

  const body =
    count === 1 ? 'You have a new message' : `You have ${count} new messages`

  const notification = new Notification({
    title: 'Orbit Mail',
    body,
    icon: getAppIconPath()
  })

  notification.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  notification.show()
}

function handleMailtoArgv(argv: string[]): void {
  const mailtoUrl = argv.find((arg) => arg.toLowerCase().startsWith('mailto:'))
  if (mailtoUrl) {
    openComposeFromMailto(mailtoUrl)
  }
}

function createMainWindow(): void {
  const windowPrefs = getWindowPreferences()
  const icon = getWindowIcon()

  mainWindow = new BrowserWindow({
    width: windowPrefs?.width ?? 1280,
    height: windowPrefs?.height ?? 800,
    x: windowPrefs?.x,
    y: windowPrefs?.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Orbit Mail',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', () => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    setWindowPreferences({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    })
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createComposeWindow(payload?: Partial<ComposePayload>): void {
  const finalPayload = enrichComposePayload(payload)

  if (composeWindow) {
    composeWindow.focus()
    composeWindow.webContents.send('compose:open', finalPayload)
    return
  }

  composeWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: 'New Message',
    icon: getWindowIcon(),
    autoHideMenuBar: true,
    parent: mainWindow ?? undefined,
    modal: false,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  composeWindow.on('ready-to-show', () => {
    composeWindow?.show()
    composeWindow?.webContents.send('compose:open', finalPayload)
  })

  composeWindow.on('closed', () => {
    composeWindow = null
  })

  composeWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const composeUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}#/compose`
    : `file://${join(__dirname, '../renderer/index.html')}#/compose`

  composeWindow.loadURL(composeUrl)
}

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => listAccounts())

  ipcMain.handle('accounts:add', async (_, provider: 'gmail' | 'o365') => {
    const tokenData =
      provider === 'gmail'
        ? await authenticateGoogle()
        : await authenticateMicrosoft()
    const account = saveAccount(provider, tokenData)
    await refreshAccount(account.id, account.provider)
    restartIdleMonitoring()
    return account
  })

  ipcMain.handle('accounts:addManual', async (_, input: ManualAccountInput) => {
    const account = await addManualAccount(input)
    await refreshAccount(account.id, account.provider)
    restartIdleMonitoring()
    return account
  })

  ipcMain.handle('accounts:autodetect', async (_, email: string) =>
    autodetectMailSettings(email)
  )

  ipcMain.handle('accounts:remove', async (_, accountId: string) => {
    removeAccount(accountId)
    restartIdleMonitoring()
  })

  ipcMain.handle('folders:list', (_, accountId?: string) => listFolders(accountId))

  ipcMain.handle(
    'messages:list',
    (_, folderId: string | 'unified', limit?: number, offset?: number) =>
      listMessages(folderId, limit, offset)
  )

  ipcMain.handle('messages:count', (_, folderId: string | 'unified') =>
    countMessages(folderId)
  )

  ipcMain.handle('messages:get', (_, messageId: string) => getMessage(messageId))

  ipcMain.handle('messages:markRead', async (_, messageId: string, isRead: boolean) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const folder = getFolderById(msg.folderId)
    if (!folder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    setMessageRead(messageId, isRead)
    await markMessageReadOnServer(
      account.id,
      account.provider,
      folder.imapPath,
      msg.uid,
      isRead
    )
  })

  ipcMain.handle('messages:toggleStar', async (_, messageId: string, isStarred: boolean) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const folder = getFolderById(msg.folderId)
    if (!folder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    setMessageStarred(messageId, isStarred)
    await toggleMessageStarredOnServer(
      account.id,
      account.provider,
      folder.imapPath,
      msg.uid,
      isStarred
    )
  })

  ipcMain.handle('messages:delete', async (_, messageId: string) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const folder = getFolderById(msg.folderId)
    if (!folder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    await deleteMessageOnServer(account.id, account.provider, folder.imapPath, msg.uid)
    deleteMessage(messageId)
  })

  ipcMain.handle('messages:move', async (_, messageId: string, targetFolderId: string) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const sourceFolder = getFolderById(msg.folderId)
    const targetFolder = getFolderById(targetFolderId)
    if (!sourceFolder || !targetFolder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    await moveMessageOnServer(
      account.id,
      account.provider,
      sourceFolder.imapPath,
      targetFolder.imapPath,
      msg.uid
    )
    deleteMessage(messageId)
    await pollForNewMessages()
  })

  ipcMain.handle('sync:refresh', async (_, accountId?: string) => {
    if (accountId) {
      const accounts = listAccounts()
      const account = accounts.find((a) => a.id === accountId)
      if (account) {
        await refreshAccount(account.id, account.provider)
      }
    } else {
      await refreshAllAccounts()
    }
  })

  ipcMain.handle('sync:getStatus', () => getSyncStatus())

  ipcMain.handle('search:query', (_, text: string, limit?: number) =>
    searchMessages(text, limit)
  )

  ipcMain.handle('compose:open', (_, payload?: Partial<ComposePayload>) => {
    createComposeWindow(payload)
  })

  ipcMain.handle('compose:send', async (_, payload: ComposePayload) => {
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === payload.accountId)
    if (!account) throw new Error('Account not found')
    await sendMail(payload, account.provider)
    await pollForNewMessages()
    composeWindow?.close()
  })

  ipcMain.handle('compose:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(composeWindow ?? mainWindow ?? undefined, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths
  })

  ipcMain.handle('compose:close', () => {
    composeWindow?.close()
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('attachments:download', async (_, attachmentId: string) => {
    const att = getAttachment(attachmentId)
    if (!att?.localPath) throw new Error('Attachment not found')
    return att.localPath
  })

  ipcMain.handle('attachments:open', async (_, attachmentId: string) => {
    const att = getAttachment(attachmentId)
    if (!att?.localPath) throw new Error('Attachment not found')
    await shell.openPath(att.localPath)
  })

  ipcMain.handle('preferences:get', () => getAppState())

  ipcMain.handle('preferences:saveUi', (_, ui) => patchUiPreferences(ui))

  ipcMain.handle('preferences:save', (_, state) => patchAppState(state))
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, argv) => {
    handleMailtoArgv(argv)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.orbitmail.app')
    }

    if (process.platform === 'linux') {
      app.setName('Orbit Mail')
    }

    if (!app.isDefaultProtocolClient('mailto')) {
      app.setAsDefaultProtocolClient('mailto')
    }

    registerIpc()
    initSyncFromPersistence()
    createMainWindow()
    startBackgroundSync()

    handleMailtoArgv(process.argv)

    setOnFolderSynced(() => {
      mainWindow?.webContents.send('sync:messagesUpdated')
    })

    setOnNewMailArrived((count) => {
      showNewMailNotification(count)
    })

    setIdleNewMailHandler(() => {
      mainWindow?.webContents.send('sync:messagesUpdated')
      showNewMailNotification(1)
    })
    startIdleMonitoring()

    onSyncStatusChange((status: SyncStatus) => {
      if (mainWindow) {
        mainWindow.webContents.send('sync:status', status)
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
  })
}

app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url.toLowerCase().startsWith('mailto:')) {
    openComposeFromMailto(url)
  }
})

app.on('before-quit', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.executeJavaScript(
      'window.__orbitMailFlush?.()',
      true
    )
  }
})

app.on('window-all-closed', () => {
  stopBackgroundSync()
  stopIdleMonitoring()
  if (process.platform !== 'darwin') app.quit()
})
