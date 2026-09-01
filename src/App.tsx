import { useEffect, useState } from 'react'
import { ThreePaneLayout } from './components/layout/ThreePaneLayout'
import { Toolbar } from './components/layout/Toolbar'
import { Sidebar } from './components/sidebar/Sidebar'
import { MessageList } from './components/list/MessageList'
import { MessageListHeader } from './components/list/MessageListHeader'
import { MessageView } from './components/reader/MessageView'
import { AddAccountWizard } from './components/accounts/AddAccountWizard'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { TasksDialog } from './components/tasks/TasksDialog'
import {
  useMailStore,
  loadInitialData,
  scheduleRefreshMessages,
  cancelScheduledRefreshMessages,
  subscribeSyncCompleteRefresh,
  saveUiPreferencesNow,
  deleteSelectedMessages,
  deleteThread,
  deleteSelectedThreads,
  openSettings,
  composeAccountId,
  performUndo,
  undoSend
} from './stores/mailStore'
import { SecureStorageBanner } from './components/SecureStorageBanner'
import { exposeFlushHook } from './stores/persistence'
import { printMessageDetail, printThreadDetails } from './utils/printMessage'
import { summarizeSyncStatus, syncErrorDetail, deriveConnectivity } from './utils/syncStatus'
import { formatWakeAt } from './utils/snoozePresets'
import { ipcErrorMessage } from './utils/ipcError'

function StatusBar() {
  const syncStatus = useMailStore((s) => s.syncStatus)
  const isOnline = useMailStore((s) => s.isOnline)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const setToast = useMailStore((s) => s.setToast)

  const syncLabel =
    syncStatus.syncTotal > 0
      ? syncStatus.syncCurrent >= syncStatus.syncTotal
        ? `Syncing ${syncStatus.syncCurrent} messages…`
        : `Syncing ${syncStatus.syncCurrent} of ${syncStatus.syncTotal}…`
      : 'Syncing…'

  const handleRetrySync = async () => {
    try {
      await window.orbitMail.sync.refresh()
    } catch (err) {
      setToast(ipcErrorMessage(err, 'Sync failed'))
    }
  }

  const summary = summarizeSyncStatus(syncStatus)
  // `isOnline` is navigator.onLine, which only earns trust when it says no;
  // the rest comes from whether syncs actually reached a server.
  const connectivity = deriveConnectivity(syncStatus, isOnline)

  return (
    <div className="status-bar">
      {connectivity.message && (
        <span className="status-offline">{connectivity.message}</span>
      )}
      {syncStatus.syncing && <span className="status-syncing">{syncLabel}</span>}
      {summary.errorLabel && (
        <span className="status-error-wrap">
          <span className="status-error" title={syncErrorDetail(summary.failing)}>
            {summary.errorLabel}
          </span>
          <button type="button" className="status-action" onClick={handleRetrySync}>
            Retry
          </button>
          {summary.needsReauth && (
            <button
              type="button"
              className="status-action"
              onClick={() => setShowAddAccount(true)}
            >
              Re-authenticate
            </button>
          )}
        </span>
      )}
      {summary.healthyLastSyncAt !== null && !syncStatus.syncing && (
        <span>
          {summary.mixed ? 'Others last synced ' : 'Last synced '}
          {new Date(summary.healthyLastSyncAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}

/**
 * The offer to take a send back, with the time remaining. Separate from the
 * toast because the two can be on screen at once — sending a message and then
 * deleting something are unrelated actions — and because this one is a
 * countdown rather than a notice.
 */
function PendingSendBar() {
  const pendingSend = useMailStore((s) => s.pendingSend)
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    if (!pendingSend) return
    const update = () =>
      setRemaining(Math.max(0, Math.ceil((pendingSend.dueAt - Date.now()) / 1000)))
    update()
    const t = setInterval(update, 250)
    return () => clearInterval(t)
  }, [pendingSend])

  if (!pendingSend) return null

  return (
    <div className="pending-send" role="status">
      <span className="pending-send-label">
        {remaining > 0 ? `Sending in ${remaining}s…` : 'Sending…'}
      </span>
      <button
        type="button"
        className="pending-send-undo"
        onClick={() => {
          void undoSend()
        }}
      >
        Undo
      </button>
    </div>
  )
}

function Toast() {
  const toast = useMailStore((s) => s.toast)
  const setToast = useMailStore((s) => s.setToast)
  const pendingUndo = useMailStore((s) => s.pendingUndo)

  useEffect(() => {
    if (!toast) return
    // Scale with length: "Deleted" needs a moment, but an error explaining
    // which checkbox to tick is ~190 characters and takes about 13 seconds to
    // read — it used to vanish after 4.
    const readMs = 4000 + toast.length * 45
    // An offer of Undo has to outlast reading the sentence that offers it, so
    // a toast carrying one gets a floor rather than a length-derived guess.
    const shownMs = pendingUndo ? Math.max(readMs, 9000) : readMs
    const t = setTimeout(() => setToast(null), Math.min(shownMs, 14000))
    return () => clearTimeout(t)
  }, [toast, setToast, pendingUndo])

  if (!toast) return null
  return (
    <div className="toast">
      <span className="toast-message">{toast}</span>
      {pendingUndo && (
        <button
          type="button"
          className="toast-action"
          onClick={() => {
            void performUndo()
          }}
        >
          Undo
        </button>
      )}
      {pendingUndo && pendingUndo.skipped > 0 && (
        <span
          className="toast-note"
          title={
            'Undo restores messages that were moved. A message deleted from Trash ' +
            'is gone from the server, and one without a Message-ID header cannot be ' +
            'found again.'
          }
        >
          {pendingUndo.skipped === 1
            ? '1 cannot be undone'
            : `${pendingUndo.skipped} cannot be undone`}
        </span>
      )}
    </div>
  )
}

function MainApp() {
  const setSyncStatus = useMailStore((s) => s.setSyncStatus)
  const setIsOnline = useMailStore((s) => s.setIsOnline)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const showSettings = useMailStore((s) => s.showSettings)
  const setShowSettings = useMailStore((s) => s.setShowSettings)
  const showTasks = useMailStore((s) => s.showTasks)
  const setShowTasks = useMailStore((s) => s.setShowTasks)

  // DIAGNOSTIC (dev only): detect stalls of the renderer UI thread. If this
  // fires while the app feels frozen, the freeze is renderer-side (a render
  // loop / heavy sync work); if it stays quiet but the UI is stuck, the block
  // is in the main process (watch its terminal for [main-lag]/[ipc-slow]).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      const drift = now - last - 1000
      if (drift > 150) console.warn(`[renderer-lag] UI thread blocked ~${Math.round(drift)}ms`)
      last = now
    }, 1000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    exposeFlushHook()
    loadInitialData()

    const updateOnline = () => setIsOnline(navigator.onLine)
    updateOnline()
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)

    const unsubSyncComplete = subscribeSyncCompleteRefresh()

    const unsubStatus = window.orbitMail.sync.onStatusChange((status) => {
      setSyncStatus(status)
      if (status.syncing) {
        cancelScheduledRefreshMessages()
      }
    })

    const unsubMessages = window.orbitMail.sync.onMessagesUpdated(() => {
      scheduleRefreshMessages()
    })

    // A send is held for a few seconds so it can be taken back. The composer
    // has already closed, so the offer lives here.
    const unsubScheduled = window.orbitMail.compose.onSendScheduled((info) => {
      const store = useMailStore.getState()
      if (info.scheduled) {
        // Timed for later: no countdown to watch. It waits in Drafts, and
        // opening it there is how you change your mind.
        store.setToast(`Scheduled to send ${formatWakeAt(info.dueAt)} — it waits in Drafts`)
        return
      }
      store.setPendingSend(info)
    })

    const unsubUnscheduled = window.orbitMail.compose.onSendUnscheduled(() => {
      useMailStore.getState().setToast('Opened for editing — no longer scheduled to send')
    })

    const unsubSent = window.orbitMail.compose.onSent(() => {
      const store = useMailStore.getState()
      store.setPendingSend(null)
      store.setToast('Message sent')
    })

    // A held send that failed. The pending-send indicator has to be cleared
    // either way, or the UI keeps offering to undo a send that already gave up.
    const unsubSendFailed = window.orbitMail.compose.onSendFailed((info) => {
      const store = useMailStore.getState()
      store.setPendingSend(null)
      store.setToast(
        `Not sent: ${info.message}` +
          (info.keptAsDraft ? ' The message is still in Drafts.' : '')
      )
    })

    // Main hit something nobody caught. Mail on disk is fine, but the process
    // is in an unknown state, so say so rather than degrading silently.
    const unsubToast = window.orbitMail.app.onToast((message) => {
      useMailStore.getState().setToast(message)
    })

    const unsubError = window.orbitMail.app.onUnexpectedError((message) => {
      useMailStore.getState().setToast(message)
    })

    return () => {
      unsubSyncComplete()
      unsubStatus()
      unsubMessages()
      unsubScheduled()
      unsubUnscheduled()
      unsubSent()
      unsubSendFailed()
      unsubError()
      unsubToast()
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [setSyncStatus, setIsOnline])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const store = useMailStore.getState()

      // Ctrl/Cmd+, opens Settings, and is the one shortcut that works with a
      // dialog already open — it is how you get to Settings from anywhere.
      if (e.key === ',' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        openSettings()
        return
      }

      // Nothing else fires behind an open dialog. The bail used to be the
      // INPUT/TEXTAREA check alone, which is fine for a form but not for a
      // dialog made of buttons: with Settings open and a tab focused, `f`
      // opened a Forward window behind it and Delete deleted the mail still
      // selected in the list underneath.
      if (store.showSettings || store.showAddAccount || store.showTasks) return

      if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
        const accountId = composeAccountId()
        if (accountId) window.orbitMail.compose.open({ accountId })
      }
      // What a per-message shortcut acts on: the open conversation's latest
      // message, or the selected one. Conversation view keeps selectedMessage
      // null, so without the thread branch these do nothing with a conversation
      // open — which is exactly how the old toolbar buttons went dead.
      const thread = store.selectedThread
      const activeMessage =
        thread && thread.length > 0 ? thread[thread.length - 1] : store.selectedMessage

      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && activeMessage) {
        window.orbitMail.compose.open({
          accountId: activeMessage.accountId,
          mode: 'reply',
          originalMessageId: activeMessage.id
        })
      }
      // `a` for reply-all, the shortcut every other mail client binds. The mode
      // has always existed and the reader has always had the button; only the
      // key was missing, on one of the most-used actions in work mail.
      if (e.key === 'a' && !e.metaKey && !e.ctrlKey && activeMessage) {
        window.orbitMail.compose.open({
          accountId: activeMessage.accountId,
          mode: 'reply-all',
          originalMessageId: activeMessage.id
        })
      }
      if (e.key === 'f' && !e.metaKey && !e.ctrlKey && activeMessage) {
        window.orbitMail.compose.open({
          accountId: activeMessage.accountId,
          mode: 'forward',
          originalMessageId: activeMessage.id
        })
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search-input')?.focus()
      }
      if ((e.key === 'p' || e.key === 'P') && (e.metaKey || e.ctrlKey)) {
        // Print the open conversation, or the selected single message.
        const thread = store.selectedThread
        if (thread && thread.length > 0) {
          e.preventDefault()
          printThreadDetails(thread).catch(() => {})
        } else if (store.selectedMessage) {
          e.preventDefault()
          printMessageDetail(store.selectedMessage).catch(() => {})
        }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (store.selectedThreadKeys.length > 1) {
          e.preventDefault()
          deleteSelectedThreads().catch(() => {})
        } else if (store.selectedThreadId && store.selectedThread?.length) {
          e.preventDefault()
          deleteThread(store.selectedThread[0].accountId, store.selectedThreadId).catch(() => {})
        } else if (store.selectedMessageIds.length || store.selectedMessageId) {
          e.preventDefault()
          deleteSelectedMessages().catch(() => {})
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    const flush = () => saveUiPreferencesNow()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(() => {
    const unsub = window.orbitMail.app.onNeedsAccount(() => setShowAddAccount(true))
    return unsub
  }, [setShowAddAccount])

  return (
    <div className="app-shell">
      <SecureStorageBanner />
      <Toolbar />
      <ThreePaneLayout
        sidebar={<Sidebar />}
        list={
          <>
            <MessageListHeader />
            <div className="message-list-body">
              <MessageList />
            </div>
          </>
        }
        reader={<MessageView />}
      />
      <StatusBar />
      <AddAccountWizard />
      {showSettings && <SettingsDialog onClose={() => setShowSettings(false)} />}
      {showTasks && <TasksDialog onClose={() => setShowTasks(false)} />}
      <PendingSendBar />
      <Toast />
    </div>
  )
}

import { ComposeWindow } from './components/compose/ComposeWindow'

export default function App() {
  const isCompose = window.location.hash === '#/compose'

  if (isCompose) {
    // The compose window needs its own Toast: it is a separate BrowserWindow, so
    // the main window's one is not on screen here. Without it every message this
    // window raises — "Please enter a recipient", a failed send, a forward that
    // could not fetch an attachment — was set into the store and never shown.
    return (
      <div className="app-shell" style={{ height: '100%' }}>
        <ComposeWindow />
        <PendingSendBar />
      <Toast />
      </div>
    )
  }

  return <MainApp />
}
