import { useEffect } from 'react'
import { ThreePaneLayout } from './components/layout/ThreePaneLayout'
import { Toolbar } from './components/layout/Toolbar'
import { Sidebar } from './components/sidebar/Sidebar'
import { MessageList } from './components/list/MessageList'
import { MessageView } from './components/reader/MessageView'
import { AddAccountWizard } from './components/accounts/AddAccountWizard'
import { AiSettingsDialog } from './components/settings/AiSettingsDialog'
import { TasksDialog } from './components/tasks/TasksDialog'
import {
  useMailStore,
  loadInitialData,
  scheduleRefreshMessages,
  cancelScheduledRefreshMessages,
  subscribeSyncCompleteRefresh,
  saveUiPreferencesNow,
  deleteSelectedMessages,
  deleteThread
} from './stores/mailStore'
import { exposeFlushHook } from './stores/persistence'
import { printMessageDetail, printThreadDetails } from './utils/printMessage'

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
      setToast(err instanceof Error ? err.message : 'Sync failed')
    }
  }

  const needsReauth =
    syncStatus.error &&
    /auth|token|login|expired|invalid_grant|consent/i.test(syncStatus.error)

  return (
    <div className="status-bar">
      {!isOnline && <span className="status-offline">Offline — showing cached mail</span>}
      {syncStatus.syncing && <span className="status-syncing">{syncLabel}</span>}
      {syncStatus.error && (
        <span className="status-error-wrap">
          <span className="status-error">{syncStatus.error}</span>
          <button type="button" className="status-action" onClick={handleRetrySync}>
            Retry
          </button>
          {needsReauth && (
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
      {syncStatus.lastSyncAt && !syncStatus.syncing && !syncStatus.error && (
        <span>
          Last synced {new Date(syncStatus.lastSyncAt).toLocaleTimeString()}
        </span>
      )}
    </div>
  )
}

function Toast() {
  const toast = useMailStore((s) => s.toast)
  const setToast = useMailStore((s) => s.setToast)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 4000)
    return () => clearTimeout(t)
  }, [toast, setToast])

  if (!toast) return null
  return <div className="toast">{toast}</div>
}

function MainApp() {
  const setSyncStatus = useMailStore((s) => s.setSyncStatus)
  const setIsOnline = useMailStore((s) => s.setIsOnline)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const showAiSettings = useMailStore((s) => s.showAiSettings)
  const setShowAiSettings = useMailStore((s) => s.setShowAiSettings)
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

    return () => {
      unsubSyncComplete()
      unsubStatus()
      unsubMessages()
      window.removeEventListener('online', updateOnline)
      window.removeEventListener('offline', updateOnline)
    }
  }, [setSyncStatus, setIsOnline])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

      const store = useMailStore.getState()

      if (e.key === 'c' && !e.metaKey && !e.ctrlKey) {
        const accountId = store.accounts[0]?.id
        if (accountId) window.orbitMail.compose.open({ accountId })
      }
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey) {
        // Reply to the latest message of the open thread, or the selected message.
        const thread = store.selectedThread
        const replyTo = thread && thread.length > 0 ? thread[thread.length - 1] : store.selectedMessage
        if (replyTo) {
          window.orbitMail.compose.open({
            accountId: replyTo.accountId,
            mode: 'reply',
            originalMessageId: replyTo.id
          })
        }
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
        if (store.selectedThreadId && store.selectedThread?.length) {
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
      <Toolbar />
      <ThreePaneLayout
        sidebar={<Sidebar />}
        list={<MessageList />}
        reader={<MessageView />}
      />
      <StatusBar />
      <AddAccountWizard />
      {showAiSettings && (
        <AiSettingsDialog onClose={() => setShowAiSettings(false)} />
      )}
      {showTasks && <TasksDialog onClose={() => setShowTasks(false)} />}
      <Toast />
    </div>
  )
}

import { ComposeWindow } from './components/compose/ComposeWindow'

export default function App() {
  const isCompose = window.location.hash === '#/compose'

  if (isCompose) {
    return (
      <div className="app-shell" style={{ height: '100%' }}>
        <ComposeWindow />
      </div>
    )
  }

  return <MainApp />
}
