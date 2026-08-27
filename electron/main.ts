import 'dotenv/config'
import { parse as parseDotenv } from 'dotenv'
import { app, BrowserWindow, ipcMain, shell, dialog, Notification, safeStorage, screen } from 'electron'
import { join, basename } from 'path'
import { statSync, writeFileSync, copyFileSync, existsSync, readFileSync } from 'fs'
import type {
  ComposePayload,
  SyncStatus,
  UndoRelocateEntry,
  ManualAccountInput,
  ManualAccountSettingsUpdate,
  FlagColor,
  SweepScope,
  DraftTone,
  SearchField,
  AttachmentDraft,
  OAuthCredentialKey,
  PlatformCapabilities,
  Provider
} from '../shared/types'
import { configureLinuxDesktopIntegration, getAppIconPath } from './app-icon'
import { takeNewMailNotice } from './services/new-mail-notice'
import {
  approveAttachmentPath,
  isAttachmentApproved,
  clearApprovedAttachments
} from './services/attachment-allowlist'
import { initTray, destroyTray, isTrayActive } from './tray'
import { cleanupExportDir, sweepStaleExportDirs } from './services/temp-export'
import { restrictExistingAttachments } from './services/attachment-permissions'
import {
  isBenignSocketError,
  describeUnexpectedError,
  formatErrorLogEntry,
  appendToErrorLog,
  type RendererErrorReport
} from './services/crash-report'
import {
  applyZoom,
  nextZoomLevel,
  sanitizeZoomLevel,
  zoomActionForInput,
  zoomPercentage
} from './zoom'
import { updateAppBadge } from './app-badge'
import {
  listAccounts,
  saveAccount,
  removeAccount,
  listFolders,
  listMessages,
  countMessages,
  listThreads,
  countThreads,
  getThread,
  getMessage,
  findMessagesByRfcId,
  getMessageServerUid,
  setMessageRead,
  setMessageStarred,
  setMessageFlag,
  deleteMessage,
  getFolderById,
  searchMessages,
  updateAccountDisplayName,
  getAccountSignature,
  setAccountSignature,
  getAccountById,
  getManualCredentials,
  getLatestInboxMessage,
  regroupThreadsIfNeeded,
  getAttachment,
  listMessageAttachments,
  backfillSearchTextBatch
} from './services/db-service'
import { suggestContacts, backfillContactsBatch } from './services/contacts'
import { appendSignature } from './services/signature'
import {
  saveDraft,
  listDrafts,
  deleteDraft,
  getDraftPayload,
  getDraftAsMessage,
  countDrafts
} from './services/draft-service'
import { authenticateGoogle } from './services/oauth-google'
import { authenticateMicrosoft } from './services/oauth-microsoft'
import {
  refreshAllAccounts,
  forgetAccountSyncStatus,
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
  reconcileAllAccountsFlags,
  setOnFolderSynced,
  setOnNewMailArrived,
  initSyncFromPersistence,
  exportMessageRawToTemp,
  syncSentFolder,
  searchServerMessages
} from './services/imap-sync'
import {
  scheduleAction,
  cancelAction,
  getAction,
  listActions,
  registerHandler,
  startScheduler,
  stopScheduler,
  type ScheduledAction
} from './services/scheduler'
import {
  startIdleMonitoring,
  stopIdleMonitoring,
  restartIdleMonitoring,
  setIdleNewMailHandler
} from './services/imap-idle'
import { closeAccountPool, closeAllPools } from './services/imap-pool'
import { reclaimFreelistIfLarge } from './db'
import { sendMail, buildReplyPayload } from './services/smtp-send'
import { autodetectMailSettings } from './services/mail-autoconfig'
import {
  addManualAccount,
  toManualSettings,
  updateManualAccountSettings,
  testManualAccountSettings
} from './services/manual-account'
import { ensureAttachmentLocal, localizeMessageAttachments } from './services/attachment-fetch'
import {
  isExecutableAttachment,
  executableAttachmentWarning
} from './services/attachment-safety'
import { getOAuthConfigStatus, setStoredOAuthCredentials } from './services/oauth-config'
import {
  getAccountInfo,
  createMailbox,
  exportMailboxToMbox,
  emptySpecialFolder,
  markFolderAllRead,
  setAccountSyncDays
} from './services/folder-actions'
import {
  addLabel,
  labelFoldersForAccount,
  listMessageLabels,
  removeLabel
} from './services/label-actions'
import {
  getAppState,
  patchAppState,
  patchUiPreferences,
  setWindowPreferences,
  getWindowPreferences,
  setComposeWindowPreferences,
  getComposeWindowPreferences,
  resolveComposeSize,
  MIN_COMPOSE_SIZE,
  setZoomLevel,
  getZoomLevel,
  muteSender,
  blockSender,
  allowSenderImages,
  unmuteSender,
  unblockSender,
  revokeSenderImages,
  clearAccountLastSyncAt
} from './services/preferences-service'
import {
  analyzeMessage,
  analyzeThread,
  getCachedThreadAnalysis,
  draftReply,
  sweepTasks,
  flagMessageAsTask,
  getCachedAnalysis,
  getPersistedTasks,
  completeTask as completeAiTask,
  reopenTask as reopenAiTask,
  isConfigured,
  setApiKey as setAiApiKey,
  clearApiKey as clearAiApiKey
} from './services/ai-service'

let mainWindow: BrowserWindow | null = null
let composeWindow: BrowserWindow | null = null
// Set only by compose:send, immediately before it closes the window. A send has
// already dealt with the message — it is in Sent and its draft row is gone — so
// the close must not run the keep-or-discard flow that an ordinary close does.
let composeSentAndClosing = false

/**
 * The main window if it is still there, null once it has gone.
 *
 * `mainWindow?.` is not enough on its own: a destroyed BrowserWindow is not
 * null, so the optional chain passes and the call throws "Object has been
 * destroyed". Nulling the reference in `closed` is not a substitute either —
 * that handler is not guaranteed to have run by the time a sync callback or
 * another window's teardown fires, and the webContents dies before the window
 * admits to being destroyed. Anything firing from a window or sync callback has
 * to ask whether the window is alive, not just whether it exists.
 *
 * The route that originally exposed this was the compose window being created
 * with `parent: mainWindow`: closing the main window destroyed the composer,
 * whose `closed` handler ran *first* and called notifyMessagesUpdated() at a
 * window that had gone. The composer is no longer a child (it has to be
 * maximizable — see createComposeWindow), so that particular ordering is gone;
 * the guard stays, because the reason for it never was that one route.
 */
function liveMainWindow(): BrowserWindow | null {
  if (!mainWindow || mainWindow.isDestroyed()) return null
  // The webContents goes *before* the window reports itself destroyed, so a
  // window-level check alone still let `webContents.send` throw — that was the
  // object in "Object has been destroyed", not the window.
  if (mainWindow.webContents.isDestroyed()) return null
  return mainWindow
}

function notifyMessagesUpdated(): void {
  const win = liveMainWindow()
  updateAppBadge(win)
  win?.webContents.send('sync:messagesUpdated')
}

// Told once per run, so a repeating background fault cannot spam the user.
let reportedUnexpectedError = false

function reportUnexpectedError(err: unknown, kind: string): void {
  if (isBenignSocketError(err)) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[orbit-mail] Suppressed IMAP socket timeout:', message)
    return
  }

  console.error(`[orbit-mail] ${kind}:`, err)

  // After an uncaught error the process state is unknown — a sync may have
  // stopped half way, a lane may still be held. Carrying on silently is a
  // guess; killing the app would cost the user their session. Tell them, once,
  // and let them pick the moment.
  if (reportedUnexpectedError) return
  reportedUnexpectedError = true
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:unexpectedError', describeUnexpectedError(err))
  }
}

process.on('uncaughtException', (err) => reportUnexpectedError(err, 'Uncaught exception'))

// Node turns an unhandled rejection into an uncaught exception, so this only
// changes the label — but the label is what tells you where to look.
process.on('unhandledRejection', (reason) => reportUnexpectedError(reason, 'Unhandled rejection'))

// A packaged app is launched from a desktop entry, so dotenv's cwd lookup above
// finds nothing. Give people running a build a place to put their own OAuth
// credentials without rebuilding. Existing environment variables win, so this
// never overrides a developer's shell or the project .env.
function loadUserEnvFile(): void {
  const path = join(app.getPath('userData'), '.env')
  if (!existsSync(path)) return
  try {
    const parsed = parseDotenv(readFileSync(path))
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value
    }
    console.log(`[orbit-mail] Loaded environment overrides from ${path}`)
  } catch (err) {
    console.warn(`[orbit-mail] Could not read ${path}:`, err)
  }
}

loadUserEnvFile()
configureLinuxDesktopIntegration()

function getWindowIcon(): string | undefined {
  return getAppIconPath()
}

// The renderer holds the full-privilege preload, so it must never navigate away
// from the app's own document: a form submit or a link inside untrusted email
// HTML would otherwise hand `window.orbitMail` to an attacker-controlled page.
// Anything that isn't the app shell is cancelled and handed to the OS browser.
function isAppUrl(url: string): boolean {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl && url.startsWith(rendererUrl)) return true
  return url.startsWith(`file://${join(__dirname, '../renderer/')}`)
}

function blockOffAppNavigation(window: BrowserWindow): void {
  const guard = (event: { preventDefault: () => void }, url: string) => {
    if (isAppUrl(url)) return
    event.preventDefault()
    if (/^https?:$/.test(safeProtocol(url))) void shell.openExternal(url)
  }

  window.webContents.on('will-navigate', guard)
  window.webContents.on('will-frame-navigate', (details) => {
    // Fires for every frame including the main one, which `will-navigate`
    // already covers — without this the browser would open twice.
    if (details.isMainFrame) return
    guard(details, details.url)
  })
}

function safeProtocol(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

// Whether a URL is safe to hand to the OS opener. `shell.openExternal` launches
// the registered handler for *any* scheme — `file:` opens a path, and custom
// schemes can invoke other installed apps — so a URL that reaches it from
// untrusted email HTML must be restricted to the web/mail schemes a link can
// legitimately be. The navigation guard above is stricter still (http/https
// only): a `mailto:` is a click to open the composer, not a page navigation.
function isSafeExternalUrl(url: string): boolean {
  return /^(?:https?|mailto):$/.test(safeProtocol(url))
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
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
      // The body comes from a URL any web page can hand us, and lands in the
      // compose editor's innerHTML — escape before building markup.
      bodyHtml: body ? `<p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>` : ''
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
  const finalPayload = appendSignature(
    enrichComposePayload(payload),
    payload?.accountId ? getAccountSignature(payload.accountId) : ''
  )

  if (
    payload?.originalMessageId &&
    (payload.mode === 'forward-attachment' || payload.mode === 'redirect')
  ) {
    try {
      const rawPath = await exportMessageRawToTemp(payload.originalMessageId)
      // Main wrote this file, so main approves it. Paths that arrived in the
      // renderer's payload are deliberately not approved here.
      approveAttachmentPath(rawPath)
      return {
        ...finalPayload,
        attachmentPaths: [rawPath, ...(payload.attachmentPaths ?? [])]
      }
    } catch (err) {
      console.warn('[orbit-mail] Could not attach raw message:', err)
    }
  }

  // A forward carries the original's attachments. Without this the quoted text
  // went out referring to a document that wasn't there — the recipient sees
  // "see attached" and no attachment, and the sender has no way to tell.
  // forward-attachment above doesn't need it: the .eml it attaches is the whole
  // message, attachments included.
  if (payload?.originalMessageId && payload.mode === 'forward') {
    const { paths, failed } = await localizeMessageAttachments(payload.originalMessageId)
    if (paths.length > 0 || failed.length > 0) {
      // Main fetched these files, so main approves them — paths that arrived in
      // the renderer's payload are still not approved here.
      for (const path of paths) approveAttachmentPath(path)
      return {
        ...finalPayload,
        attachmentPaths: [...paths, ...(payload.attachmentPaths ?? [])],
        // Say so rather than quietly sending an incomplete forward.
        notice:
          failed.length > 0
            ? `Couldn't attach ${
                failed.length === 1 ? failed[0] : `${failed.length} attachments`
              } — check your connection before sending.`
            : undefined
      }
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

/**
 * How long a send is held so it can be taken back. Ten seconds is long enough
 * to notice the mistake you make as you click, and short enough that nobody
 * wonders whether the message went. Fixed for now — see TODO.md for making it a
 * setting, which is what people eventually want from it.
 */
const UNDO_SEND_MS = 10_000

/**
 * Where snoozed mail waits. A plain folder name rather than a special one:
 * every IMAP server can make it, it is visible in webmail and on a phone, and
 * a user who abandons Orbit is left with their mail in an obvious place.
 */
const SNOOZE_FOLDER = 'Snoozed'

/** Told the renderer once the message is actually away, so it can say so. */
function notifySendCompleted(subject: string): void {
  const win = liveMainWindow()
  if (win) win.webContents.send('compose:sent', subject)
}

/**
 * The composer closes the moment Send is pressed, so the offer to take it back
 * has to live in the main window — which otherwise would not know a send had
 * been scheduled at all.
 */
function notifySendScheduled(info: { scheduledId: string; dueAt: number; subject: string }): void {
  const win = liveMainWindow()
  if (win) win.webContents.send('compose:scheduled', info)
}

function showNewMailNotification(count: number): void {
  // Whether to interrupt, and about what, is decided in `takeNewMailNotice` —
  // both announcing paths (the IDLE push handler and the safety-net poll) route
  // through here, and one of them is usually about mail the other has already
  // announced. Deliberately not gated further up in the sync layer: the unread
  // badge and the tray count must keep updating whether or not the user wants to
  // be interrupted about it.
  if (!Notification.isSupported()) return

  const notice = takeNewMailNotice(count)
  if (!notice) return
  const latest = notice.message

  // Account on the (bold) title line; sender and subject in the body, each
  // truncated so the notification stays within a sensible width.
  const title = truncate(latest.accountLabel, 64)
  const sender = truncate(senderName(latest.from) || 'Unknown sender', 40)
  const subject = truncate(latest.subject || '(no subject)', 80)
  let body = `${sender}\n${subject}`
  if (count > 1) body += `\n+${count - 1} more message${count - 1 === 1 ? '' : 's'}`

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
  // Reached from `second-instance` and the mailto handler, either of which can
  // arrive after the window has gone (a compose window keeps the app alive), so
  // this needs the live check rather than a null one.
  const win = liveMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
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

/**
 * Write a renderer failure down, and tell the user their window is recoverable.
 *
 * The failure this exists for leaves no trace of its own: a render error blanks
 * the window while the renderer process keeps running, so nothing crashes,
 * nothing is logged, and the console holding the stack belongs to a window the
 * user cannot open. The log file is the whole point — the next occurrence has
 * to leave evidence behind or it stays unfixable.
 */
function recordRendererError(report: RendererErrorReport): void {
  try {
    const path = join(app.getPath('userData'), 'renderer-errors.log')
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, appendToErrorLog(existing, formatErrorLogEntry(report, Date.now())), {
      mode: 0o600
    })
  } catch {
    // Logging must never be the thing that breaks the app it is reporting on.
  }
  console.error(`[orbit-mail] renderer ${report.source} error: ${report.message}`)
}

/**
 * The two ways a window can go blank, both of which used to be silent.
 *
 * `render-process-gone` is the process actually dying — the window survives as
 * a white rectangle and every `mainWindow?.…` guard still passes, because a
 * live BrowserWindow with a dead renderer is neither null nor destroyed. A
 * reload is the correct recovery for a mail client: state lives in SQLite, not
 * in the renderer, so nothing is lost by rebuilding the view.
 *
 * `unresponsive` is the renderer alive but wedged. That is *not* recovered
 * automatically — a long synchronous render recovers on its own, and reloading
 * out from under someone mid-compose would be worse than the freeze.
 */
function watchForRendererFailure(window: BrowserWindow, label: string, reload: boolean): void {
  window.webContents.on('render-process-gone', (_event, details) => {
    recordRendererError({
      source: 'window',
      message: `renderer process gone: ${details.reason}${
        details.exitCode !== undefined ? ` (exit ${details.exitCode})` : ''
      }`,
      window: label
    })
    // 'clean-exit' is the window closing normally; there is nothing to recover.
    if (!reload || details.reason === 'clean-exit' || window.isDestroyed()) return
    window.webContents.reload()
    window.webContents.once('did-finish-load', () => {
      if (!window.isDestroyed()) {
        window.webContents.send('app:toast', 'Orbit Mail recovered from a display error.')
      }
    })
  })

  window.webContents.on('unresponsive', () => {
    recordRendererError({ source: 'window', message: 'renderer became unresponsive', window: label })
  })
}

/**
 * Windows that follow the zoom level. Tracked explicitly rather than asking for
 * every open window, because the print window is a `BrowserWindow` too and
 * zooming that would change what comes out of the printer.
 */
const zoomedWindows = new Set<BrowserWindow>()

/**
 * Make a window follow the app's zoom level, and let the browser shortcuts
 * change it.
 *
 * Zoom is applied on every load, not just at creation: the level belongs to the
 * loaded frame, so a navigation or a reload resets it to 100% — including the
 * reload that recovers from a dead renderer, which would otherwise silently
 * undo the user's setting at the worst possible moment.
 */
function attachZoom(window: BrowserWindow): void {
  zoomedWindows.add(window)
  window.on('closed', () => zoomedWindows.delete(window))

  const apply = (): void => applyZoom(window, sanitizeZoomLevel(getZoomLevel()))
  apply()
  window.webContents.on('did-finish-load', apply)

  window.webContents.on('before-input-event', (event, input) => {
    const action = zoomActionForInput(input)
    if (!action) return
    event.preventDefault()

    const level = nextZoomLevel(sanitizeZoomLevel(getZoomLevel()), action)
    setZoomLevel(level)
    // Every window moves together. A composer left at a different size from the
    // window it was opened from reads as a bug, not a feature.
    for (const target of zoomedWindows) applyZoom(target, level)

    if (!window.isDestroyed()) {
      window.webContents.send('app:toast', `Zoom ${zoomPercentage(level)}%`)
    }
  })
}


function createMainWindow(): void {
  const windowPrefs = getWindowPreferences()
  const icon = getWindowIcon()

  mainWindow = new BrowserWindow({
    width: windowPrefs?.width ?? 1280,
    height: windowPrefs?.height ?? 800,
    x: windowPrefs?.x,
    y: windowPrefs?.y,
    // 900 made the sidebar's collapse breakpoint unreachable — the window
    // could never get narrow enough to trigger it — and, more to the point,
    // made the app impossible to snap to half of a 1366-wide laptop screen.
    // The floor is what two usable panes need: MIN_LIST + MIN_READER + the
    // divider, which is 581, plus room for the toolbar.
    minWidth: 660,
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

  watchForRendererFailure(mainWindow, 'main', true)
  attachZoom(mainWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // The reference has to go when the window does, the way composeWindow's does.
  // Every `mainWindow?.…` here guards against null, not against a *destroyed*
  // window — and a destroyed BrowserWindow is not null, so those guards passed
  // and the call threw "Object has been destroyed" from a composer's `closed`
  // handler, which called notifyMessagesUpdated() — badge, title and a send to
  // the renderer — on the window that had just gone. Reads go through
  // liveMainWindow() now; the two places that already checked isDestroyed() by
  // hand (the quit flush, reportUnexpectedError) were working around this.
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // DIAGNOSTIC (dev only): surface renderer console (incl. [renderer-lag] and
  // React errors) in the same terminal as the main-process logs.
  if (!app.isPackaged) {
    mainWindow.webContents.on('console-message', (_e, _l, message) => {
      if (/lag|error|warning|maximum update/i.test(message)) console.log('[renderer]', message)
    })
  }

  mainWindow.on('close', (event) => {
    if (!mainWindow) return
    const bounds = mainWindow.getBounds()
    setWindowPreferences({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    })

    // Closing the window hides it to the tray instead of quitting — mail keeps
    // syncing in the background and the count stays live in the panel. Quitting
    // is deliberate: the tray's "Quit", or the menu's File → Quit (Ctrl+Q),
    // both route through before-quit, which sets isQuitting so this lets the
    // window close. Only when a tray actually exists to reopen from (Linux with
    // the icon installed); everywhere else close quits as before.
    // Read at close time rather than captured when the window was made, so the
    // setting applies without a restart. `!== false` and not `=== true`: an
    // install predating the key has it absent, and absent must keep today's
    // behaviour.
    if (!isQuitting && isTrayActive() && getAppState().closeToTray !== false) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  blockOffAppNavigation(mainWindow)

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

  // Remembered from the last composer, resolved against the display this one is
  // about to appear on — see resolveComposeSize for why a stored size is not
  // trusted as given.
  const storedSize = getComposeWindowPreferences()
  const size = resolveComposeSize(storedSize, screen.getPrimaryDisplay().workAreaSize)

  composeWindow = new BrowserWindow({
    width: size.width,
    height: size.height,
    minWidth: MIN_COMPOSE_SIZE.width,
    minHeight: MIN_COMPOSE_SIZE.height,
    title: 'New Message',
    icon: getWindowIcon(),
    autoHideMenuBar: true,
    // Deliberately *not* `parent: mainWindow`. Electron's `parent` sets the X11
    // WM_TRANSIENT_FOR hint, and a transient window is a dialog to the window
    // manager: Muffin (Cinnamon) and Mutter (GNOME) clear its maximize function
    // outright, so `maximize()` was a silent no-op, the maximize button was
    // absent, and the composer could not be tiled. Nothing in Electron reported
    // this — `isMaximizable()`, `isMovable()` and `isResizable()` all still
    // returned true, because the flags are ours and the veto is the WM's.
    // Writing a message deserves a full-size window, so the composer is an
    // ordinary top-level one. The costs, both accepted: it no longer floats
    // above the main window, and closing the main window no longer destroys it
    // — which also means a half-written message survives that close.
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Reported, but deliberately not reloaded: a composer holds text the user is
  // part-way through writing, and reloading restores only what autosave has
  // already taken. Losing the last few sentences silently would be a worse
  // outcome than the blank window, so this one is theirs to decide.
  // Before `show`, not in `ready-to-show`: maximizing a window the user can
  // already see is a visible jump from small to full-screen on every composer.
  // The known cost, measured rather than assumed: a window maximized before it
  // is mapped has no normal geometry for the WM to restore *to*, so Muffin
  // invents one (~90% of the screen) and the first "restore down" gives a size
  // the user never chose. Re-imposing the remembered size from an `unmaximize`
  // handler was tried and is **worse** — the WM finishes its own restore after
  // that runs and snaps the window back to the maximized rectangle, so restore
  // down appeared to do nothing at all. One unexpected size beats a control that
  // looks broken, and neither is worth fighting the window manager over.
  if (storedSize?.maximized) composeWindow.maximize()

  watchForRendererFailure(composeWindow, 'compose', false)
  attachZoom(composeWindow)

  composeWindow.on('ready-to-show', () => {
    composeWindow?.show()
    composeWindow?.webContents.send('compose:open', finalPayload)
  })

  // Closing keeps whatever was being written, so the window must not go before
  // the last autosave has landed — the debounce may have up to ~800ms of typing
  // still unwritten, which is exactly the content someone would be most annoyed
  // to lose. Same shape as the quit flush: ask the renderer, wait for its
  // promise, close for real, and never let a wedged renderer trap the window.
  let closingAfterFlush = false
  composeWindow.on('close', (event) => {
    // First thing in the handler, before any of the flush dance below can
    // return early: whatever else this close does, the size is what the user
    // last chose. `getNormalBounds` rather than `getBounds` when maximized —
    // the latter reports the maximized rectangle, and storing that would make
    // "restore down" on the next composer do nothing visible.
    if (composeWindow && !composeWindow.isDestroyed()) {
      const maximized = composeWindow.isMaximized()
      const bounds = maximized ? composeWindow.getNormalBounds() : composeWindow.getBounds()
      setComposeWindowPreferences({ width: bounds.width, height: bounds.height, maximized })
    }

    // A close that follows a successful send has nothing left to save: the
    // draft id the renderer still holds names the row compose:send has already
    // deleted, so flushing would ask "save this as a draft?" about a message
    // that has been sent — and "Save draft" would then report a draft that no
    // longer exists as filed.
    if (composeSentAndClosing) return
    if (closingAfterFlush || !composeWindow) return
    event.preventDefault()
    closingAfterFlush = true
    const win = composeWindow
    const finish = () => {
      closingAfterFlush = true
      win.close()
    }

    void (async () => {
      // Save first, then ask. If the dialog or anything after it fails, the
      // message still exists — the opposite order risks losing it to a crash
      // between the question and the answer.
      // Raced against a timeout: a wedged renderer must never leave a window
      // that cannot be closed. Losing the last ~800ms of typing in that case is
      // the lesser failure.
      const draftId: string | null = await Promise.race([
        win.webContents
          .executeJavaScript('window.__orbitMailFlushDraft?.()', true)
          .catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
      ])

      if (!draftId) {
        finish()
        return
      }

      // Keeping it silently was the original design and testing showed it is
      // wrong: an unsent message quietly filed somewhere is indistinguishable
      // from one lost, and drafts accumulate from composers opened and thought
      // better of.
      const { response } = await dialog.showMessageBox(win, {
        type: 'question',
        buttons: ['Save draft', 'Discard', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        message: 'Save this message as a draft?',
        detail: 'Saved drafts appear in the Drafts folder for this account.'
      })

      if (response === 2) {
        // Back to editing. The draft stays saved — a later close asks again.
        closingAfterFlush = false
        return
      }

      if (response === 1) {
        deleteDraft(draftId)
        notifyMessagesUpdated()
        finish()
        return
      }

      // Say *where* it went: a draft belongs to the composer's From account,
      // which is not necessarily the folder being read, and looking in the
      // wrong Drafts folder reads as the draft having been lost.
      const account = listAccounts().find(
        (a) => a.id === getDraftPayload(draftId)?.payload.accountId
      )
      liveMainWindow()?.webContents.send(
        'app:toast',
        account ? `Draft saved in ${account.email} → Drafts` : 'Draft saved'
      )
      finish()
    })()
  })

  composeWindow.on('closed', () => {
    composeWindow = null
    // The next composer starts as an unsent message again.
    composeSentAndClosing = false
    // Approval is per compose session: a file chosen for one message should not
    // still be attachable from the next one.
    clearApprovedAttachments()
    // The Drafts folder's contents and count just changed.
    notifyMessagesUpdated()
  })

  composeWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  blockOffAppNavigation(composeWindow)

  const composeUrl = process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}#/compose`
    : `file://${join(__dirname, '../renderer/index.html')}#/compose`

  composeWindow.loadURL(composeUrl)
}

// Prints a self-contained HTML document (built in the renderer from the message
// headers + sanitized body) by loading it into a hidden, script-free window and
// invoking the OS print dialog. Resolves once the dialog is dismissed; a user
// cancel resolves with { printed: false } rather than rejecting.
function printDocument(html: string): Promise<{ printed: boolean }> {
  return new Promise((resolve, reject) => {
    const printWindow = new BrowserWindow({
      show: false,
      parent: mainWindow ?? undefined,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The document is untrusted email HTML — no scripting, no preload.
        javascript: false
      }
    })

    let settled = false
    const finish = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
      if (!printWindow.isDestroyed()) printWindow.close()
    }

    printWindow.webContents.once('did-finish-load', () => {
      printWindow.webContents.print(
        { silent: false, printBackground: true },
        (success, failureReason) => {
          // "cancelled" (dialog dismissed) is a normal outcome, not an error.
          if (!success && failureReason && failureReason !== 'cancelled') {
            finish(() => reject(new Error(failureReason)))
          } else {
            finish(() => resolve({ printed: success }))
          }
        }
      )
    })

    printWindow.webContents.once('did-fail-load', (_e, _code, description) => {
      finish(() => reject(new Error(description || 'Failed to load print document')))
    })

    printWindow
      .loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      .catch((err: unknown) => {
        finish(() => reject(err instanceof Error ? err : new Error('Failed to load print document')))
      })
  })
}

function registerIpc(): void {
  // DIAGNOSTIC (dev only): time every IPC handler and warn on slow ones, so a
  // handler that blocks the main-process event loop (and thus freezes all
  // renderer IPC) is easy to spot in the terminal.
  if (!app.isPackaged) {
    const origHandle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = function (channel: string, listener: (...a: never[]) => unknown) {
      return origHandle(channel, async (event, ...args) => {
        const started = Date.now()
        try {
          return await (listener as (...a: unknown[]) => unknown)(event, ...args)
        } finally {
          const ms = Date.now() - started
          if (ms > 80) console.warn(`[ipc-slow] ${channel} ${ms}ms`)
        }
      })
    } as typeof ipcMain.handle
  }

  ipcMain.handle('accounts:list', () => listAccounts())

  // The first sync of a newly added account runs in the background so the UI can
  // show the account and close the Add Account dialog the moment auth + save is
  // done, rather than waiting out the whole initial fetch. Folders and messages
  // stream into the sidebar as they arrive (each synced folder fires the
  // folder-synced notification the renderer already listens for). IDLE is
  // (re)started only once the sync has created the inbox folder it needs.
  const syncNewAccountInBackground = (accountId: string, provider: Provider): void => {
    void refreshAccount(accountId, provider)
      .then(() => restartIdleMonitoring())
      .catch((err) =>
        console.warn('[orbit-mail] Initial sync after adding an account failed:', err)
      )
  }

  ipcMain.handle('accounts:add', async (_, provider: 'gmail' | 'o365') => {
    const tokenData =
      provider === 'gmail'
        ? await authenticateGoogle()
        : await authenticateMicrosoft()
    const account = saveAccount(provider, tokenData)
    syncNewAccountInBackground(account.id, account.provider)
    return account
  })

  ipcMain.handle('accounts:addManual', async (_, input: ManualAccountInput) => {
    const account = await addManualAccount(input)
    syncNewAccountInBackground(account.id, account.provider)
    return account
  })

  ipcMain.handle('accounts:autodetect', async (_, email: string) =>
    autodetectMailSettings(email)
  )

  ipcMain.handle('accounts:remove', async (_, accountId: string) => {
    removeAccount(accountId)
    // Sync status and its persisted timestamp are keyed by account id and are
    // not covered by the DB's cascading deletes, so they have to be dropped
    // explicitly or a removed account keeps reporting state in the sidebar.
    forgetAccountSyncStatus(accountId)
    clearAccountLastSyncAt(accountId)
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

  ipcMain.handle('accounts:updateSignature', (_, accountId: string, signature: string) => {
    setAccountSignature(accountId, signature)
  })

  ipcMain.handle('accounts:getSignature', (_, accountId: string) =>
    getAccountSignature(accountId)
  )

  ipcMain.handle('accounts:getManualSettings', (_, accountId: string) => {
    const account = getAccountById(accountId)
    if (!account || (account.provider !== 'imap' && account.provider !== 'pop3')) return null
    const creds = getManualCredentials(accountId)
    if (!creds) return null
    // Projected field by field — the stored credentials carry the plaintext
    // password and it must not cross into the renderer.
    return toManualSettings(creds, account.provider)
  })

  ipcMain.handle(
    'accounts:updateManualSettings',
    async (_, accountId: string, update: ManualAccountSettingsUpdate) => {
      const account = await updateManualAccountSettings(accountId, update)
      // The pooled client and the IDLE monitor are still authenticated with the
      // settings that were just replaced. accounts:remove does the same pair.
      await closeAccountPool(accountId)
      restartIdleMonitoring()
      return account
    }
  )

  ipcMain.handle(
    'accounts:testManualSettings',
    async (_, accountId: string, update: ManualAccountSettingsUpdate) => {
      try {
        await testManualAccountSettings(accountId, update)
        return { ok: true }
      } catch (err) {
        // Resolved, not thrown: the form shows this inline next to the button.
        return { ok: false, error: err instanceof Error ? err.message : 'Could not connect' }
      }
    }
  )

  ipcMain.handle(
    'messages:list',
    (_, folderId: string | 'unified', limit?: number, offset?: number, unreadOnly?: boolean) =>
      listMessages(folderId, limit, offset, unreadOnly)
  )

  ipcMain.handle('messages:count', (_, folderId: string | 'unified', unreadOnly?: boolean) =>
    countMessages(folderId, unreadOnly)
  )

  ipcMain.handle(
    'messages:listThreads',
    (_, folderId: string | 'unified', limit?: number, offset?: number, unreadOnly?: boolean) =>
      listThreads(folderId, limit, offset, unreadOnly)
  )

  ipcMain.handle('messages:countThreads', (_, folderId: string | 'unified', unreadOnly?: boolean) =>
    countThreads(folderId, unreadOnly)
  )

  ipcMain.handle('messages:getThread', (_, accountId: string, threadId: string) =>
    getThread(accountId, threadId)
  )

  ipcMain.handle('messages:get', (_, messageId: string) => {
    // A draft row selected in the list. Drafts are not in `messages`, so one is
    // projected into the same shape and the reader needs no separate path.
    // Clicking a draft used to open the composer outright, which meant a draft
    // could never be selected — and so never deleted, or even read without
    // committing to editing it.
    if (messageId.startsWith('draft:')) {
      const draftId = messageId.slice('draft:'.length)
      const accountId = getDraftPayload(draftId)?.payload.accountId
      const folderId =
        listFolders().find((f) => f.type === 'drafts' && f.accountId === accountId)?.id ?? ''
      return getDraftAsMessage(draftId, folderId)
    }
    return getMessage(messageId)
  })

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

    await deleteMessageOnServer(
      account.id,
      account.provider,
      folder.imapPath,
      msg.uid,
      getMessageServerUid(messageId)
    )
    deleteMessage(messageId)
    notifyMessagesUpdated()
  })

  // Batch relocate: each item moves to its target folder, or is deleted outright
  // when the target is null. One reconciliation poll + notify covers the whole
  // batch instead of one full poll per message.
  //
  // `deleteMany` and `moveMany` are the same operation — the two channels exist
  // so a delete call site and an archive/move call site each read honestly.
  const relocateMany = async (items: { id: string; targetFolderId: string | null }[]) => {
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
            msg.uid,
            getMessageServerUid(item.id)
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

  ipcMain.handle('messages:deleteMany', (_, items: { id: string; targetFolderId: string | null }[]) =>
    relocateMany(items)
  )

  // Undo: put relocated messages back. This is the same batch move in reverse,
  // so it inherits relocateMany's per-item error handling and its single
  // reconciliation poll.
  //
  // Entries arrive keyed by RFC Message-ID rather than local row id, because the
  // row the caller acted on no longer exists — a move deletes it locally and the
  // poll re-imports the message under a new uid and id.
  ipcMain.handle('messages:undoRelocate', async (_, entries: UndoRelocateEntry[]) => {
    const items: { id: string; targetFolderId: string | null }[] = []
    let missing = 0

    for (const entry of entries) {
      const rows = findMessagesByRfcId(entry.accountId, entry.rfcMessageId)
      // A row already sitting in the destination needs no move — on Gmail the
      // message keeps a row per label, so undoing an archive means finding the
      // one that is *not* already in the folder we are restoring to.
      const row = rows.find((r) => r.folderId !== entry.folderId)
      if (!row) {
        // Either the message never came back from the server, or it is already
        // where it belongs. Counted, not silently dropped.
        missing++
        continue
      }
      items.push({ id: row.id, targetFolderId: entry.folderId })
    }

    if (items.length === 0) return { restored: 0, failed: missing }

    const result = await relocateMany(items)
    return { restored: result.deleted, failed: result.failed + missing }
  })
  ipcMain.handle('messages:moveMany', (_, items: { id: string; targetFolderId: string | null }[]) =>
    relocateMany(items)
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

  ipcMain.handle('messages:labels', (_, messageIds: string[]) =>
    listMessageLabels(messageIds)
  )

  ipcMain.handle('messages:availableLabels', (_, accountId: string) =>
    labelFoldersForAccount(accountId)
  )

  // A label change is a COPY or an expunge on the server, so the folder it
  // landed in has a row we do not have yet (add) or has lost one we still have
  // (remove, already deleted locally). One poll covers the batch, the same way
  // the bulk relocate does.
  ipcMain.handle('messages:addLabel', async (_, messageIds: string[], folderId: string) => {
    const result = await addLabel(messageIds, folderId)
    if (result.changed > 0) {
      await pollForNewMessages({ announce: false })
      notifyMessagesUpdated()
    }
    return result
  })

  ipcMain.handle('messages:removeLabel', async (_, messageIds: string[], folderId: string) => {
    const result = await removeLabel(messageIds, folderId)
    if (result.changed > 0) notifyMessagesUpdated()
    return result
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

  ipcMain.handle(
    'search:query',
    (_, text: string, accountId: string | null, field?: SearchField, limit?: number) =>
      searchMessages(text, accountId, field, limit)
  )

  ipcMain.handle('search:server', (_, text: string, accountId: string | null, field?: SearchField) =>
    searchServerMessages(text, accountId, field)
  )

  ipcMain.handle('compose:open', async (_, payload?: Partial<ComposePayload>) => {
    await createComposeWindow(payload)
  })

  // The send itself, with no scheduling around it. Called by the scheduler when
  // an undo window closes or a timed send falls due — never directly by the
  // renderer, which now only ever *schedules* a send.
  const performSend = async (payload: ComposePayload): Promise<void> => {
    const account = listAccounts().find((a) => a.id === payload.accountId)
    if (!account) throw new Error('Account not found')
    await sendMail(payload, account.provider)
    // The draft has been sent, so it is no longer a draft. Deliberately after
    // sendMail resolves: dropping it first would lose the message if the send
    // then failed, which is precisely what drafts exist to prevent.
    if (payload.draftId) deleteDraft(payload.draftId)
    // Only sync the Sent folder for this account so the message shows up, rather
    // than firing a full multi-account resync for every send.
    try {
      await syncSentFolder(account.id, account.provider)
      notifyMessagesUpdated()
    } catch {
      // Sending succeeded; a Sent-folder sync hiccup shouldn't fail the send.
    }
  }

  registerHandler('send', async (action) => {
    const payload = action.payload as { compose?: ComposePayload } | null
    if (!payload?.compose) return
    await performSend(payload.compose)
    notifySendCompleted(payload.compose.subject ?? '')
  })

  ipcMain.handle('compose:send', async (_, payload: ComposePayload) => {
    const account = listAccounts().find((a) => a.id === payload.accountId)
    if (!account) throw new Error('Account not found')

    // Kept as a draft for the length of the undo window, so Undo has something
    // to reopen and a quit inside the window loses nothing. The scheduled
    // handler deletes it once the message is actually away.
    const draftId = payload.draftId ?? saveDraft(payload) ?? undefined
    const compose: ComposePayload = { ...payload, draftId }

    const dueAt = Date.now() + UNDO_SEND_MS
    const scheduledId = scheduleAction({
      accountId: account.id,
      kind: 'send',
      dueAt,
      payload: { compose }
    })

    // Tells the close handler this close is the tail of a send, not someone
    // abandoning a message — see composeSentAndClosing. Set only alongside a
    // close that will actually happen, so the flag cannot outlive this window
    // and silence the prompt for the next message.
    if (composeWindow) {
      composeSentAndClosing = true
      composeWindow.close()
    }

    notifySendScheduled({ scheduledId, dueAt, subject: payload.subject ?? '' })

    return { scheduledId, dueAt, draftId: draftId ?? null }
  })

  /**
   * The folder a snoozed message waits in, created on the server if absent.
   *
   * A real folder rather than a local flag, so the message genuinely leaves the
   * inbox on your phone and in webmail too. A snooze that only hides mail in
   * this app would leave the inbox lying everywhere else, which is the opposite
   * of what snoozing is for.
   */
  const ensureSnoozeFolder = async (accountId: string) => {
    const existing = listFolders(accountId).find(
      (f) => f.name === SNOOZE_FOLDER || f.imapPath === SNOOZE_FOLDER
    )
    if (existing) return existing

    await createMailbox(accountId, SNOOZE_FOLDER)
    await pollForNewMessages({ announce: false })
    return listFolders(accountId).find(
      (f) => f.name === SNOOZE_FOLDER || f.imapPath === SNOOZE_FOLDER
    )
  }

  const runSnoozeAction = async (action: ScheduledAction): Promise<void> => {
    const payload = action.payload as
      | { rfcMessageId?: string; folderId?: string }
      | null
    if (!payload?.rfcMessageId || !payload.folderId) return

    // The row it was snoozed from no longer exists — a move deletes it locally
    // and the poll re-imports the message under a new id. Found by Message-ID,
    // the same handle undo uses and for the same reason.
    const rows = findMessagesByRfcId(action.accountId, payload.rfcMessageId)
    const row = rows.find((r) => r.folderId !== payload.folderId)
    if (!row) return

    // The folder it came from may have been deleted while it slept. Better the
    // inbox than nowhere, so it is not silently lost.
    const home = getFolderById(payload.folderId)
      ? payload.folderId
      : (listFolders(action.accountId).find((f) => f.type === 'inbox')?.id ?? null)
    if (!home) return

    await relocateMany([{ id: row.id, targetFolderId: home }])
    notifyMessagesUpdated()
    const win = liveMainWindow()
    if (win) win.webContents.send('messages:unsnoozed', payload.rfcMessageId)
  }

  registerHandler('snooze', runSnoozeAction)

  ipcMain.handle(
    'messages:snooze',
    async (_, messageIds: string[], wakeAt: number) => {
      let snoozed = 0
      let failed = 0

      for (const messageId of messageIds) {
        const msg = getMessage(messageId)
        if (!msg || !msg.messageId) {
          // No Message-ID means no way to find it again when it is due, so it
          // cannot be snoozed at all. Counted, not silently skipped.
          failed++
          continue
        }
        const folder = await ensureSnoozeFolder(msg.accountId)
        if (!folder) {
          failed++
          continue
        }
        const from = msg.folderId
        const result = await relocateMany([{ id: messageId, targetFolderId: folder.id }])
        if (result.deleted === 0) {
          failed++
          continue
        }
        scheduleAction({
          accountId: msg.accountId,
          kind: 'snooze',
          dueAt: wakeAt,
          payload: { rfcMessageId: msg.messageId, folderId: from }
        })
        snoozed++
      }

      notifyMessagesUpdated()
      return { snoozed, failed }
    }
  )

  /** Everything currently asleep, so the UI can say when each is due back. */
  ipcMain.handle('messages:listSnoozed', () =>
    listActions('snooze').map((a) => ({
      id: a.id,
      accountId: a.accountId,
      wakeAt: a.dueAt,
      rfcMessageId: (a.payload as { rfcMessageId?: string })?.rfcMessageId ?? ''
    }))
  )

  /** Bring one back now rather than waiting for it to be due. */
  ipcMain.handle('messages:unsnooze', async (_, scheduledId: string) => {
    const action = getAction(scheduledId)
    if (!action || !cancelAction(scheduledId)) return false
    // Reuse the handler's own logic by running it directly: due-now and
    // asked-for-now should not be two different code paths.
    await runSnoozeAction(action)
    return true
  })

  // Undo: drop the pending send and hand back the draft to reopen. Returns
  // false when the window has already closed and the message is gone — the one
  // answer the renderer must not paper over.
  ipcMain.handle('compose:cancelSend', (_, scheduledId: string) => {
    const action = getAction(scheduledId)
    const cancelled = cancelAction(scheduledId)
    const payload = action?.payload as { compose?: ComposePayload } | null
    return {
      cancelled,
      draftId: cancelled ? (payload?.compose?.draftId ?? null) : null
    }
  })

  ipcMain.handle('compose:pickAttachments', async () => {
    const result = await dialog.showOpenDialog(composeWindow ?? mainWindow ?? undefined, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return []
    // The user picked these in an OS dialog, so they are approved to attach.
    for (const filePath of result.filePaths) approveAttachmentPath(filePath)
    return result.filePaths.map(pathToAttachmentDraft).filter(Boolean) as AttachmentDraft[]
  })

  // A real drag-and-drop. The preload resolves the path with webUtils, which
  // returns nothing for a File the renderer constructs, so this cannot be used
  // to name an arbitrary file.
  ipcMain.handle('compose:attachDroppedFile', (_, path: string) => {
    if (typeof path !== 'string' || path.length === 0) return null
    const draft = pathToAttachmentDraft(path)
    if (!draft) return null
    approveAttachmentPath(path)
    return draft
  })

  // Only describes files already approved: the renderer can call this with any
  // path, and file size and existence are worth something to an attacker.
  ipcMain.handle('compose:statAttachments', (_, paths: string[]) =>
    paths
      .filter((path) => isAttachmentApproved(path))
      .map(pathToAttachmentDraft)
      .filter(Boolean) as AttachmentDraft[]
  )

  ipcMain.handle('compose:close', () => {
    composeWindow?.close()
  })

  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    // The renderer is not trusted to have vetted this — it may be a raw link
    // from a message body. Refuse anything that is not http(s)/mailto rather
    // than launch an arbitrary scheme's handler.
    if (!isSafeExternalUrl(url)) return
    await shell.openExternal(url)
  })

  ipcMain.handle('print:document', (_, html: string) => printDocument(html))

  ipcMain.handle('attachments:download', async (_, attachmentId: string) => {
    return ensureAttachmentLocal(attachmentId)
  })

  // Returns false if the user declined the "this may run code" prompt.
  ipcMain.handle('attachments:open', async (_, attachmentId: string) => {
    const att = getAttachment(attachmentId)
    const filename = att?.filename ?? ''

    if (isExecutableAttachment(filename)) {
      const { message, detail } = executableAttachmentWarning(filename)
      const options = {
        type: 'warning' as const,
        buttons: ['Cancel', 'Open anyway'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message,
        detail
      }
      const { response } = mainWindow
        ? await dialog.showMessageBox(mainWindow, options)
        : await dialog.showMessageBox(options)
      if (response !== 1) return false
    }

    const localPath = await ensureAttachmentLocal(attachmentId)
    await shell.openPath(localPath)
    return true
  })

  // Save a single attachment to a user-chosen location. Returns the saved path,
  // or null if the user cancelled the dialog.
  ipcMain.handle('attachments:saveAs', async (_, attachmentId: string) => {
    const att = getAttachment(attachmentId)
    if (!att) throw new Error('Attachment not found')
    const localPath = await ensureAttachmentLocal(attachmentId)
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      defaultPath: att.filename
    })
    if (result.canceled || !result.filePath) return null
    copyFileSync(localPath, result.filePath)
    return result.filePath
  })

  // Save every attachment on a message into a user-chosen directory. Returns the
  // number of files saved, or null if the user cancelled the dialog.
  ipcMain.handle('attachments:saveAll', async (_, messageId: string) => {
    // Real attachments only. "Save all" on a message whose sender has a logo in
    // their signature should not write out a directory of image.png copies; the
    // embedded ones are still saveable one at a time from the reader.
    const atts = listMessageAttachments(messageId).filter((att) => !att.isInline)
    if (atts.length === 0) throw new Error('No attachments to save')
    const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const dir = result.filePaths[0]

    // Avoid clobbering when two attachments share a filename: suffix duplicates.
    const usedNames = new Set<string>()
    let saved = 0
    for (const att of atts) {
      const localPath = await ensureAttachmentLocal(att.id)
      let name = basename(att.filename)
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.')
        const stem = dot > 0 ? name.slice(0, dot) : name
        const ext = dot > 0 ? name.slice(dot) : ''
        let n = 1
        while (usedNames.has(`${stem} (${n})${ext}`)) n++
        name = `${stem} (${n})${ext}`
      }
      usedNames.add(name)
      copyFileSync(localPath, join(dir, name))
      saved++
    }
    return saved
  })

  ipcMain.handle('preferences:get', () => getAppState())

  ipcMain.handle('preferences:saveUi', (_, ui) => patchUiPreferences(ui))

  ipcMain.handle('preferences:save', (_, state) => patchAppState(state))

  ipcMain.handle('preferences:setHandleMailtoLinks', (_, enabled: boolean) => {
    patchAppState({ handleMailtoLinks: enabled })
    configureMailtoProtocolClient(enabled)
    // Report what the OS actually thinks, not what we asked for. On Linux the
    // registration is an xdg association keyed on an installed .desktop file,
    // so it silently no-ops in `npm run dev` — echoing `enabled` would show a
    // switch as on while mailto: links still open somewhere else.
    return app.isDefaultProtocolClient('mailto')
  })

  ipcMain.handle(
    'app:getPlatformCapabilities',
    (): PlatformCapabilities => ({
      trayActive: isTrayActive(),
      notificationsSupported: Notification.isSupported(),
      mailtoHandlerActive: app.isDefaultProtocolClient('mailto')
    })
  )

  ipcMain.handle('preferences:muteSender', (_, email: string) => {
    muteSender(email)
    // Mute changes which mail can raise a notification, not which mail is
    // shown, so nothing needs refreshing.
    return getAppState().mutedSenders ?? []
  })

  ipcMain.handle('preferences:allowSenderImages', (_, email: string) => {
    allowSenderImages(email)
    return getAppState().imageAllowedSenders ?? []
  })

  ipcMain.handle('preferences:blockSender', (_, email: string) => {
    // Blocking one of the user's own addresses would be self-inflicted and
    // strange: every Sent row is from them, so it would empty their Sent list
    // and hide their own replies inside conversations. Sent folders are exempt
    // from the filter as a second lock, but refusing here is the honest place
    // to say why.
    const own = listAccounts().map((account) => account.email.trim().toLowerCase())
    const target = email.replace(/.*<([^>]+)>.*/, '$1').trim().toLowerCase()
    if (own.includes(target)) {
      throw new Error('That is one of your own addresses — blocking it would hide your own mail.')
    }
    blockSender(email)
    notifyMessagesUpdated()
    return getAppState().blockedSenders ?? []
  })

  // Removal. Each returns the resulting list so the renderer can replace its
  // copy without a second read.
  ipcMain.handle('preferences:unmuteSender', (_, email: string) => unmuteSender(email))

  ipcMain.handle('preferences:unblockSender', (_, email: string) => {
    const next = unblockSender(email)
    // Their mail comes straight back — it was only ever hidden, never deleted —
    // but the list on screen was rendered without it.
    notifyMessagesUpdated()
    return next
  })

  ipcMain.handle('preferences:revokeSenderImages', (_, email: string) =>
    revokeSenderImages(email)
  )

  ipcMain.handle('app:reportRendererError', (_event, report: RendererErrorReport) => {
    recordRendererError(report)
  })

  ipcMain.handle('app:getSecureStorageStatus', () => ({
    available: safeStorage.isEncryptionAvailable()
  }))

  ipcMain.handle('oauth:getStatus', () => getOAuthConfigStatus())

  // Values arrive from the renderer, are written encrypted, and are never read
  // back out to it — the reply is the same status shape as getStatus.
  ipcMain.handle(
    'oauth:saveCredentials',
    (_, values: Partial<Record<OAuthCredentialKey, string>>) => {
      setStoredOAuthCredentials(values ?? {})
      return getOAuthConfigStatus()
    }
  )

  ipcMain.handle(
    'drafts:save',
    (_, payload: Partial<ComposePayload>, draftId?: string) => {
      const id = saveDraft(payload, draftId)
      // The Drafts folder lists these, so its row count changes with them.
      notifyMessagesUpdated()
      return id
    }
  )

  ipcMain.handle('drafts:list', (_, accountId: string) => listDrafts(accountId))

  ipcMain.handle('drafts:discard', (_, draftId: string) => {
    deleteDraft(draftId)
    notifyMessagesUpdated()
  })

  ipcMain.handle('drafts:open', async (_, draftId: string) => {
    const draft = getDraftPayload(draftId)
    if (!draft) throw new Error('That draft no longer exists')
    // The attachment allowlist is per-session, and this draft may predate a
    // restart — main read these paths from its own database and checked they
    // still exist, so main approves them. Paths that arrived from the renderer
    // are still never approved here.
    for (const path of draft.payload.attachmentPaths ?? []) approveAttachmentPath(path)
    await createComposeWindow({
      ...draft.payload,
      notice:
        draft.missingAttachments.length > 0
          ? `${draft.missingAttachments.join(', ')} ${
              draft.missingAttachments.length === 1 ? 'is' : 'are'
            } no longer on disk and could not be re-attached.`
          : undefined
    })
  })

  ipcMain.handle(
    'contacts:suggest',
    (_, accountId: string, query: string, limit?: number) =>
      suggestContacts(accountId, query, limit)
  )

  ipcMain.handle(
    'ai:analyze',
    (_, messageId: string, force?: boolean, includeAttachments?: boolean) =>
      analyzeMessage(messageId, { force, includeAttachments })
  )

  ipcMain.handle(
    'ai:draftReply',
    (_, messageId: string, tone: DraftTone, mode?: 'reply' | 'reply-all') =>
      draftReply(messageId, { tone, mode })
  )

  ipcMain.handle('ai:sweep', (_, folderId: string, scope: SweepScope, force?: boolean) =>
    sweepTasks(folderId, scope, force === true)
  )

  ipcMain.handle('ai:getTasks', (_, folderId: string) => getPersistedTasks(folderId))

  ipcMain.handle('ai:flagAsTask', (_, folderId: string, messageId: string) =>
    flagMessageAsTask(folderId, messageId)
  )

  ipcMain.handle('ai:getCachedAnalysis', (_, messageId: string) => getCachedAnalysis(messageId))

  ipcMain.handle(
    'ai:analyzeThread',
    (_, accountId: string, threadId: string, force?: boolean) =>
      analyzeThread(accountId, threadId, { force })
  )

  ipcMain.handle('ai:getCachedThreadAnalysis', (_, accountId: string, threadId: string) =>
    getCachedThreadAnalysis(accountId, threadId)
  )

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
    // Re-launching Orbit Mail always brings the window back to the front — the
    // recovery path when it has been hidden to a tray the desktop doesn't draw.
    handleMailtoArgv(argv)
    focusMainWindow()
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

    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        '[orbit-mail] No OS keyring available — stored credentials (passwords, ' +
          'tokens, API keys) are obfuscated, not encrypted. Install gnome-keyring ' +
          'or kwallet for encryption at rest.'
      )
    }

    setOnFolderSynced(() => {
      notifyMessagesUpdated()
    })

    setOnNewMailArrived((count) => {
      updateAppBadge(liveMainWindow())
      showNewMailNotification(count)
    })

    setIdleNewMailHandler(() => {
      notifyMessagesUpdated()
      showNewMailNotification(1)
    })

    onSyncStatusChange((status: SyncStatus) => {
      const win = liveMainWindow()
      if (win) {
        win.webContents.send('sync:status', status)
      }
      if (!status.syncing) {
        updateAppBadge(win)
      }
    })

    // DIAGNOSTIC (dev only): detect stalls of the main-process event loop. A
    // large drift means something synchronous is blocking IPC (which freezes the
    // UI). Prints how long the loop was blocked.
    if (!app.isPackaged) {
      let lastTick = Date.now()
      const lagTimer = setInterval(() => {
        const now = Date.now()
        const drift = now - lastTick - 1000
        if (drift > 150) console.warn(`[main-lag] event loop blocked ~${drift}ms`)
        lastTick = now
      }, 1000)
      lagTimer.unref()
    }

    // One-time upgrade: transitively re-link conversations so existing split
    // threads merge before the renderer's first (local) query. No-op after the
    // first run (guarded by a preferences flag).
    regroupThreadsIfNeeded()

    // Show the window as early as possible; the renderer then loads the user's
    // cached mail from the local DB. Local-only setup (mailto handler, badge)
    // stays here since it's cheap.
    initSyncFromPersistence()
    // Anything that fell due while the app was closed runs on this first tick:
    // a send held when the app quit, a snooze that came due overnight.
    startScheduler()
    createMainWindow()
    // Tray before the first badge update, so that update paints the count.
    initTray(() => liveMainWindow())
    updateAppBadge(liveMainWindow())
    configureMailtoProtocolClient(getAppState().handleMailtoLinks === true)
    handleMailtoArgv(process.argv)

    // Defer background network — IMAP IDLE connections and the polling loop —
    // until after the first render and the renderer's initial (local) data load,
    // so opening several IMAP sockets doesn't compete with startup paint.
    // Populate search_text for mail synced before that column existed, one small
    // batch at a time with a yield between, so the ~5s of HTML-stripping never
    // becomes a single freeze. Search stays correct throughout (it falls back to
    // body_html for rows not yet reached), and this drains once — new mail gets
    // search_text on upsert.
    // The same shape serves the contacts backfill below: both walk a backlog in
    // small batches, yielding between them, and stop when a batch reports
    // nothing left. A failure ends that drain and is logged — neither backfill
    // is worth degrading the app over.
    const drainInBackground = (label: string, batch: () => number): void => {
      let done = false
      const step = (): void => {
        if (done) return
        try {
          if (batch() === 0) {
            done = true
            return
          }
        } catch (err) {
          done = true
          console.warn(`[orbit-mail] ${label} backfill stopped:`, err)
          return
        }
        setTimeout(step, 60)
      }
      setTimeout(step, 2000)
    }

    const startBackgroundWork = () => {
      // One immediate catch-up sync so the list refreshes shortly after launch,
      // then settle into the differentiated poll cadence (fast POP3, slow IDLE).
      pollForNewMessages().catch(() => {})
      // Reconcile server flag changes (read/star) once on launch so state that
      // drifted while the app was closed is corrected promptly.
      reconcileAllAccountsFlags({ filter: (a) => a.provider !== 'pop3' }).catch(() => {})
      startBackgroundSync()
      startIdleMonitoring()
      drainInBackground('search-text', backfillSearchTextBatch)
      // Collect addresses from mail that was already synced when autocomplete
      // arrived. New mail is harvested as it lands, so this drains once.
      drainInBackground('contacts', backfillContactsBatch)
      // Export directories left by a run that crashed before it could clean up.
      const swept = sweepStaleExportDirs()
      if (swept > 0) console.log(`[orbit-mail] removed ${swept} stale export dir(s)`)

      // One-time: attachment files downloaded before they were written 0600.
      try {
        const { scanned, tightened } = restrictExistingAttachments()
        if (tightened > 0) {
          console.log(
            `[orbit-mail] tightened permissions on ${tightened} of ${scanned} attachment file(s)`
          )
        }
      } catch (err) {
        console.warn('[orbit-mail] attachment permission sweep failed:', err)
      }
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

// Quitting waits for the renderer to persist its UI state — which folder and
// message were open, dark mode, the collapsed accounts. This used to fire the
// flush and carry on quitting, so the last change before quit was routinely
// lost: change a setting, quit, and it was as if you had not.
let quitFlushed = false

// Set the instant a real quit begins (tray "Quit", File → Quit, OS logout), so
// the window's close handler stops hiding to the tray and lets the window close.
let isQuitting = false

app.on('before-quit', (event) => {
  isQuitting = true
  const teardown = (): void => {
    // Stop the ticker rather than let it fire mid-shutdown. Pending work is on
    // disk, so a send held when the app quits is dispatched at the next start
    // instead — late, but not lost. Sending it *during* quit would mean an
    // outbound SMTP connection racing the process teardown.
    stopScheduler()
    destroyTray()
    // The raw .eml files written for forward-as-attachment are whole emails.
    cleanupExportDir()
  }

  if (quitFlushed || !mainWindow || mainWindow.isDestroyed()) {
    teardown()
    return
  }

  event.preventDefault()
  quitFlushed = true

  let finished = false
  const finish = (): void => {
    if (finished) return
    finished = true
    teardown()
    app.quit()
  }

  // __orbitMailFlush returns the save's promise, so this resolves once the
  // write has happened rather than once it has been requested.
  mainWindow.webContents
    .executeJavaScript('window.__orbitMailFlush?.()', true)
    .catch(() => {
      // A renderer that cannot flush must not keep the app open.
    })
    .finally(finish)

  // A wedged renderer must never hold the app hostage.
  setTimeout(finish, 2000)
})

app.on('window-all-closed', () => {
  stopBackgroundSync()
  stopIdleMonitoring()
  void closeAllPools()
  // The window is gone, so this is a good moment to reclaim database freelist
  // space if it has grown large — the brief VACUUM block is invisible here.
  // Rare (self-throttling), and skipped silently on error, e.g. if a sync write
  // is still settling.
  try {
    const reclaimed = reclaimFreelistIfLarge()
    if (reclaimed > 0) {
      console.log(
        `[orbit-mail] Compacted database on exit, reclaimed ~${Math.round(reclaimed / 1024 / 1024)} MB`
      )
    }
  } catch (err) {
    console.warn('[orbit-mail] Database compaction skipped:', err)
  }
  if (process.platform !== 'darwin') app.quit()
})
