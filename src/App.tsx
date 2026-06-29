import { useEffect } from 'react'
import { ThreePaneLayout } from './components/layout/ThreePaneLayout'
import { Toolbar } from './components/layout/Toolbar'
import { Sidebar } from './components/sidebar/Sidebar'
import { MessageList } from './components/list/MessageList'
import { MessageView } from './components/reader/MessageView'
import { AddAccountWizard } from './components/accounts/AddAccountWizard'
import {
  useMailStore,
  loadInitialData,
  refreshMessages,
  saveUiPreferencesNow,
  moveMessageToTrash
} from './stores/mailStore'
import { exposeFlushHook } from './stores/persistence'

function StatusBar() {
  const syncStatus = useMailStore((s) => s.syncStatus)
  const isOnline = useMailStore((s) => s.isOnline)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const setToast = useMailStore((s) => s.setToast)

  const syncLabel =
    syncStatus.syncTotal > 0
      ? `Syncing ${syncStatus.syncCurrent} of ${syncStatus.syncTotal}…`
      : 'Syncing…'

  const handleRetrySync = async () => {
    try {
      await window.orbitMail.sync.refresh()
      await refreshMessages()
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

  useEffect(() => {
    exposeFlushHook()
    loadInitialData()
    let lastRefreshAt = 0
    let lastSyncCurrent = -1

    const updateOnline = () => setIsOnline(navigator.onLine)
    updateOnline()
    window.addEventListener('online', updateOnline)
    window.addEventListener('offline', updateOnline)

    const unsubStatus = window.orbitMail.sync.onStatusChange((status) => {
      setSyncStatus(status)

      if (status.syncing) {
        const shouldRefresh =
          status.syncCurrent !== lastSyncCurrent &&
          (status.syncCurrent - lastSyncCurrent >= 10 ||
            status.syncCurrent === 0 ||
            Date.now() - lastRefreshAt >= 1000)

        if (shouldRefresh) {
          lastSyncCurrent = status.syncCurrent
          lastRefreshAt = Date.now()
          refreshMessages()
        }
        return
      }

      if (status.lastSyncAt) {
        refreshMessages()
      }
    })

    const unsubMessages = window.orbitMail.sync.onMessagesUpdated(() => {
      refreshMessages()
    })

    return () => {
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
      if (e.key === 'r' && !e.metaKey && !e.ctrlKey && store.selectedMessage) {
        window.orbitMail.compose.open({
          accountId: store.selectedMessage.accountId,
          mode: 'reply',
          originalMessageId: store.selectedMessage.id
        })
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search-input')?.focus()
      }
      if (e.key === 'Delete' && store.selectedMessageId) {
        moveMessageToTrash(store.selectedMessageId).catch(() => {})
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
