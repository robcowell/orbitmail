import 'dotenv/config'
import { app, BrowserWindow, ipcMain, shell, dialog, Notification } from 'electron'
import { join, basename } from 'path'
import { statSync, writeFileSync } from 'fs'
import type {
  ComposePayload,
  SyncStatus,
  ManualAccountInput,
  FlagColor,
  SweepScope,
  DraftTone,
  AttachmentDraft
} from '../shared/types'
import { configureLinuxDesktopIntegration, getAppIconPath } from './app-icon'
import { updateAppBadge } from './app-badge'
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
  setMessageFlag,
  deleteMessage,
  getFolderById,
  searchMessages,
  updateAccountDisplayName,
  getLatestInboxMessage
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
  copyMessageOnServer,
  refreshAccount,
  pollForNewMessages,
  setOnFolderSynced,
  setOnNewMailArrived,
  initSyncFromPersistence,
  exportMessageRawToTemp,
  syncSentFolder
} from './services/imap-sync'
import {
  startIdleMonitoring,
  stopIdleMonitoring,
  restartIdleMonitoring,
  setIdleNewMailHandler
} from './services/imap-idle'
import { closeAccountPool, closeAllPools } from './services/imap-pool'
import { sendMail, buildReplyPayload } from './services/smtp-send'
import { autodetectMailSettings } from './services/mail-autoconfig'
import { addManualAccount } from './services/manual-account'
import { ensureAttachmentLocal } from './services/attachment-fetch'
import {
  getAccountInfo,
  createMailbox,
  exportMailboxToMbox,
  emptySpecialFolder,
  markFolderAllRead,
  setAccountSyncDays
} from './services/folder-actions'
import {
  getAppState,
  patchAppState,
  patchUiPreferences,
  setWindowPreferences,
  getWindowPreferences,
  muteSender,
  blockSender
} from './services/preferences-service'
import {
  analyzeMessage,
  draftReply,
  sweepTasks,
  getPersistedTasks,
  completeTask as completeAiTask,
  reopenTask as reopenAiTask,
  isConfigured,
  setApiKey as setAiApiKey,
  clearApiKey as clearAiApiKey
} from './services/ai-service'

let mainWindow: BrowserWindow | null = null
let composeWindow: BrowserWindow | null = null
let lastNotificationAt = 0

function notifyMessagesUpdated(): void {
  updateAppBadge(mainWindow)
  mainWindow?.webContents.send('sync:messagesUpdated')
}

process.on('uncaughtException', (err) => {
  const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : ''
  if (code === 'ETIMEOUT' || err.message === 'Socket timeout') {
    console.warn('[orbit-mail] Suppressed IMAP socket timeout:', err.message)
    return
  }
  console.error('[orbit-mail] Uncaught exception:', err)
})

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

function pathToAttachmentDraft(path: string): AttachmentDraft | null {
  try {
    return { path, name: basename(path), size: statSync(path).size }
  } catch {
    return null
  }
}

function enrichComposePayload(payload?: Partial<ComposePayload>): Partial<ComposePayload> {
  if (!payload?.originalMessageId || !payload.mode || payload.mode === 'new') {
    return payload ?? {}
  }

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

async function prepareComposePayload(
  payload?: Partial<ComposePayload>
): Promise<Partial<ComposePayload>> {
  const finalPayload = enrichComposePayload(payload)

  if (
    payload?.originalMessageId &&
    (payload.mode === 'forward-attachment' || payload.mode === 'redirect')
  ) {
    try {
      const rawPath = await exportMessageRawToTemp(payload.originalMessageId)
      return {
        ...finalPayload,
        attachmentPaths: [rawPath, ...(payload.attachmentPaths ?? [])]
      }
    } catch (err) {
      console.warn('[orbit-mail] Could not attach raw message:', err)
    }
  }

  return finalPayload
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

function truncate(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed
}

// Pull a display name out of a From header ("Jane Doe" <jane@x> -> Jane Doe),
// falling back to the bare address.
function senderName(from: string): string {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/)
  const name = match?.[1]?.trim()
  if (name) return name
  return from.replace(/[<>]/g, '').trim()
}

function showNewMailNotification(count: number): void {
  if (!Notification.isSupported()) return
  if (Date.now() - lastNotificationAt < 5000) return
  lastNotificationAt = Date.now()

  const latest = getLatestInboxMessage()

  // Account on the (bold) title line; sender and subject in the body, each
  // truncated so the notification stays within a sensible width.
  let title = 'Orbit Mail'
  let body = count === 1 ? 'You have a new message' : `You have ${count} new messages`

  if (latest) {
    title = truncate(latest.accountLabel, 64)
    const sender = truncate(senderName(latest.from) || 'Unknown sender', 40)
    const subject = truncate(latest.subject || '(no subject)', 80)
    body = `${sender}\n${subject}`
    if (count > 1) body += `\n+${count - 1} more message${count - 1 === 1 ? '' : 's'}`
  }

  const notification = new Notification({
    title,
    body,
    icon: getAppIconPath()
  })

  notification.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })

  notification.show()
}

function handleMailtoArgv(argv: string[]): boolean {
  const mailtoUrl = argv.find((arg) => arg.toLowerCase().startsWith('mailto:'))
  if (!mailtoUrl) return false
  openComposeFromMailto(mailtoUrl)
  return true
}

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function configureMailtoProtocolClient(enabled: boolean): void {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    if (enabled) {
      if (!app.isDefaultProtocolClient('mailto')) {
        app.setAsDefaultProtocolClient('mailto')
      }
    } else if (app.isDefaultProtocolClient('mailto')) {
      app.removeAsDefaultProtocolClient('mailto')
    }
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

async function createComposeWindow(payload?: Partial<ComposePayload>): Promise<void> {
  const finalPayload = await prepareComposePayload(payload)

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
    await closeAccountPool(accountId)
    restartIdleMonitoring()
  })

  ipcMain.handle('folders:list', (_, accountId?: string) => listFolders(accountId))

  ipcMain.handle('folders:create', async (_, accountId: string, name: string) => {
    await createMailbox(accountId, name)
    await pollForNewMessages()
  })

  ipcMain.handle('folders:export', async (_, folderId: string) => {
    const folder = getFolderById(folderId)
    if (!folder) throw new Error('Folder not found')

    const safeName = folder.name.replace(/[^\w\s-]/g, '').trim() || 'mailbox'
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      defaultPath: `${safeName}.mbox`,
      filters: [{ name: 'Mailbox', extensions: ['mbox'] }]
    })
    if (result.canceled || !result.filePath) return -1

    return exportMailboxToMbox(folderId, result.filePath)
  })

  ipcMain.handle('folders:emptyTrash', async (_, accountId: string) => {
    const count = await emptySpecialFolder(accountId, 'trash')
    await pollForNewMessages()
    notifyMessagesUpdated()
    return count
  })

  ipcMain.handle('folders:emptyJunk', async (_, accountId: string) => {
    const count = await emptySpecialFolder(accountId, 'junk')
    await pollForNewMessages()
    notifyMessagesUpdated()
    return count
  })

  ipcMain.handle('folders:markAllRead', async (_, folderId: string) => {
    const count = await markFolderAllRead(folderId)
    notifyMessagesUpdated()
    return count
  })

  ipcMain.handle('accounts:getInfo', (_, accountId: string) => getAccountInfo(accountId))

  ipcMain.handle('accounts:updateDisplayName', (_, accountId: string, displayName: string) =>
    updateAccountDisplayName(accountId, displayName)
  )

  ipcMain.handle('accounts:updateSyncDays', (_, accountId: string, syncDays: number) =>
    setAccountSyncDays(accountId, syncDays)
  )

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
    notifyMessagesUpdated()
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

  ipcMain.handle('messages:setFlag', async (_, messageId: string, flagColor: FlagColor | null) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const folder = getFolderById(msg.folderId)
    if (!folder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    setMessageFlag(messageId, flagColor)
    await toggleMessageStarredOnServer(
      account.id,
      account.provider,
      folder.imapPath,
      msg.uid,
      flagColor !== null
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
    notifyMessagesUpdated()
  })

  // Batch delete/move: resolve each item's server op, run them, then do a single
  // reconciliation poll + notify instead of one full poll per message.
  ipcMain.handle(
    'messages:deleteMany',
    async (_, items: { id: string; targetFolderId: string | null }[]) => {
      const accounts = listAccounts()
      let deleted = 0
      let failed = 0

      for (const item of items) {
        try {
          const msg = getMessage(item.id)
          if (!msg) {
            failed++
            continue
          }
          const account = accounts.find((a) => a.id === msg.accountId)
          const sourceFolder = getFolderById(msg.folderId)
          if (!account || !sourceFolder) {
            failed++
            continue
          }

          if (item.targetFolderId) {
            const targetFolder = getFolderById(item.targetFolderId)
            if (!targetFolder) {
              failed++
              continue
            }
            await moveMessageOnServer(
              account.id,
              account.provider,
              sourceFolder.imapPath,
              targetFolder.imapPath,
              msg.uid
            )
          } else {
            await deleteMessageOnServer(
              account.id,
              account.provider,
              sourceFolder.imapPath,
              msg.uid
            )
          }
          deleteMessage(item.id)
          deleted++
        } catch {
          failed++
        }
      }

      await pollForNewMessages({ announce: false })
      notifyMessagesUpdated()
      return { deleted, failed }
    }
  )

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
    await pollForNewMessages({ announce: false })
    notifyMessagesUpdated()
  })

  ipcMain.handle('messages:copy', async (_, messageId: string, targetFolderId: string) => {
    const msg = getMessage(messageId)
    if (!msg) return
    const sourceFolder = getFolderById(msg.folderId)
    const targetFolder = getFolderById(targetFolderId)
    if (!sourceFolder || !targetFolder) return
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === msg.accountId)
    if (!account) return

    await copyMessageOnServer(
      account.id,
      account.provider,
      sourceFolder.imapPath,
      targetFolder.imapPath,
      msg.uid
    )
    await pollForNewMessages({ announce: false })
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

  ipcMain.handle('search:query', (_, text: string, accountId: string, limit?: number) =>
    searchMessages(text, accountId, limit)
  )

  ipcMain.handle('compose:open', async (_, payload?: Partial<ComposePayload>) => {
    await createComposeWindow(payload)
  })

  ipcMain.handle('compose:send', async (_, payload: ComposePayload) => {
    const accounts = listAccounts()
    const account = accounts.find((a) => a.id === payload.accountId)
    if (!account) throw new Error('Account not found')
    await sendMail(payload, account.provider)
    // Only sync the Sent folder for this account so the message shows up, rather
    // than firing a full multi-account resync for every send.
    try {
      await syncSentFolder(account.id, account.provider)
      notifyMessagesUpdated()
    } catch {
      // Sending succeeded; a Sent-folder sync hiccup shouldn't fail the send.
    }
    composeWindow?.close()
  })

  ipcMain.handle('compose:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(composeWindow ?? mainWindow ?? undefined, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    return result.filePaths.map(pathToAttachmentDraft).filter(Boolean) as AttachmentDraft[]
  })

  ipcMain.handle('compose:statAttachments', (_, paths: string[]) =>
    paths.map(pathToAttachmentDraft).filter(Boolean) as AttachmentDraft[]
  )

  ipcMain.handle('compose:close', () => {
    composeWindow?.close()
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    await shell.openExternal(url)
  })

  ipcMain.handle('attachments:download', async (_, attachmentId: string) => {
    return ensureAttachmentLocal(attachmentId)
  })

  ipcMain.handle('attachments:open', async (_, attachmentId: string) => {
    const localPath = await ensureAttachmentLocal(attachmentId)
    await shell.openPath(localPath)
  })

  ipcMain.handle('preferences:get', () => getAppState())

  ipcMain.handle('preferences:saveUi', (_, ui) => patchUiPreferences(ui))

  ipcMain.handle('preferences:save', (_, state) => patchAppState(state))

  ipcMain.handle('preferences:setHandleMailtoLinks', (_, enabled: boolean) => {
    patchAppState({ handleMailtoLinks: enabled })
    configureMailtoProtocolClient(enabled)
    return enabled
  })

  ipcMain.handle('preferences:muteSender', (_, email: string) => {
    muteSender(email)
  })

  ipcMain.handle('preferences:blockSender', (_, email: string) => {
    blockSender(email)
  })

  ipcMain.handle('ai:analyze', (_, messageId: string, force?: boolean) =>
    analyzeMessage(messageId, { force })
  )

  ipcMain.handle(
    'ai:draftReply',
    (_, messageId: string, tone: DraftTone, mode?: 'reply' | 'reply-all') =>
      draftReply(messageId, { tone, mode })
  )

  ipcMain.handle('ai:sweep', (_, folderId: string, scope: SweepScope) =>
    sweepTasks(folderId, scope)
  )

  ipcMain.handle('ai:getTasks', (_, folderId: string) => getPersistedTasks(folderId))

  ipcMain.handle('ai:exportTasks', async (_, markdown: string, defaultName: string) => {
    const result = await dialog.showSaveDialog(composeWindow ?? mainWindow ?? undefined, {
      defaultPath: defaultName,
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    })
    if (result.canceled || !result.filePath) return null
    writeFileSync(result.filePath, markdown, 'utf8')
    return result.filePath
  })

  ipcMain.handle('ai:completeTask', (_, folderId: string, taskId: string) => {
    completeAiTask(folderId, taskId)
  })

  ipcMain.handle('ai:reopenTask', (_, folderId: string, taskId: string) => {
    reopenAiTask(folderId, taskId)
  })

  ipcMain.handle('ai:getStatus', () => ({ configured: isConfigured() }))

  ipcMain.handle('ai:setApiKey', (_, key: string) => {
    setAiApiKey(key)
  })

  ipcMain.handle('ai:clearApiKey', () => {
    clearAiApiKey()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, argv) => {
    if (handleMailtoArgv(argv)) {
      focusMainWindow()
    }
  })

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.orbitmail.app')
    }

    if (process.platform === 'linux') {
      app.setName('Orbit Mail')
    }

    // Register IPC handlers and wire the sync callbacks first, so the renderer's
    // initial data requests are served the moment the window loads and any
    // sync-triggered event has a handler.
    registerIpc()

    setOnFolderSynced(() => {
      notifyMessagesUpdated()
    })

    setOnNewMailArrived((count) => {
      updateAppBadge(mainWindow)
      showNewMailNotification(count)
    })

    setIdleNewMailHandler(() => {
      notifyMessagesUpdated()
      showNewMailNotification(1)
    })

    onSyncStatusChange((status: SyncStatus) => {
      if (mainWindow) {
        mainWindow.webContents.send('sync:status', status)
      }
      if (!status.syncing) {
        updateAppBadge(mainWindow)
      }
    })

    // Show the window as early as possible; the renderer then loads the user's
    // cached mail from the local DB. Local-only setup (mailto handler, badge)
    // stays here since it's cheap.
    initSyncFromPersistence()
    createMainWindow()
    updateAppBadge(mainWindow)
    configureMailtoProtocolClient(getAppState().handleMailtoLinks === true)
    handleMailtoArgv(process.argv)

    // Defer background network — IMAP IDLE connections and the polling loop —
    // until after the first render and the renderer's initial (local) data load,
    // so opening several IMAP sockets doesn't compete with startup paint.
    const startBackgroundWork = () => {
      // One immediate catch-up sync so the list refreshes shortly after launch,
      // then settle into the differentiated poll cadence (fast POP3, slow IDLE).
      pollForNewMessages().catch(() => {})
      startBackgroundSync()
      startIdleMonitoring()
    }
    if (mainWindow) {
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(startBackgroundWork, 500)
      })
    } else {
      startBackgroundWork()
    }

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
  void closeAllPools()
  if (process.platform !== 'darwin') app.quit()
})
