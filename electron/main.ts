import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import type { Provider, ComposePayload, SyncStatus } from '../shared/types'
import {
  listAccounts,
  saveAccount,
  removeAccount,
  listFolders,
  listMessages,
  getMessage,
  setMessageRead,
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
  deleteMessageOnServer,
  moveMessageOnServer,
  refreshAccount,
  setOnFolderSynced
} from './services/imap-sync'
import { sendMail, buildReplyPayload } from './services/smtp-send'

let mainWindow: BrowserWindow | null = null
let composeWindow: BrowserWindow | null = null

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Orbit Mail',
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
  if (composeWindow) {
    composeWindow.focus()
    composeWindow.webContents.send('compose:open', payload ?? {})
    return
  }

  composeWindow = new BrowserWindow({
    width: 640,
    height: 720,
    minWidth: 480,
    minHeight: 400,
    title: 'New Message',
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
    composeWindow?.webContents.send('compose:open', payload ?? {})
  })

  composeWindow.on('closed', () => {
    composeWindow = null
  })

  const composeUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}#/compose`
    : `file://${join(__dirname, '../renderer/index.html')}#/compose`

  composeWindow.loadURL(composeUrl)
}

function registerIpc(): void {
  ipcMain.handle('accounts:list', () => listAccounts())

  ipcMain.handle('accounts:add', async (_, provider: Provider) => {
    const tokenData =
      provider === 'gmail'
        ? await authenticateGoogle()
        : await authenticateMicrosoft()
    const account = saveAccount(provider, tokenData)
    await refreshAllAccounts()
    return account
  })

  ipcMain.handle('accounts:remove', async (_, accountId: string) => {
    removeAccount(accountId)
  })

  ipcMain.handle('folders:list', (_, accountId?: string) => listFolders(accountId))

  ipcMain.handle(
    'messages:list',
    (_, folderId: string | 'unified', limit?: number, offset?: number) =>
      listMessages(folderId, limit, offset)
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
    await refreshAllAccounts()
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
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.orbitmail.app')
  }

  registerIpc()
  createMainWindow()
  startBackgroundSync()

  setOnFolderSynced(() => {
    mainWindow?.webContents.send('sync:messagesUpdated')
  })

  // Push sync status to renderer
  onSyncStatusChange((status: SyncStatus) => {
    if (mainWindow) {
      mainWindow.webContents.send('sync:status', status)
    }
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  stopBackgroundSync()
  if (process.platform !== 'darwin') app.quit()
})
