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
  refreshMessages
} from './stores/mailStore'

function StatusBar() {
  const syncStatus = useMailStore((s) => s.syncStatus)

  const syncLabel =
    syncStatus.syncTotal > 0
      ? `Syncing ${syncStatus.syncCurrent} of ${syncStatus.syncTotal}…`
      : 'Syncing…'

  return (
    <div className="status-bar">
      {syncStatus.syncing && <span className="status-syncing">{syncLabel}</span>}
      {syncStatus.error && <span className="status-error">{syncStatus.error}</span>}
      {syncStatus.lastSyncAt && !syncStatus.syncing && (
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

  useEffect(() => {
    loadInitialData()
    let lastRefreshAt = 0
    let lastSyncCurrent = -1

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
    }
  }, [setSyncStatus])

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
          to: store.selectedMessage.from,
          subject: `Re: ${store.selectedMessage.subject.replace(/^Re:\s*/, '')}`,
          bodyText: `\n\n${store.selectedMessage.bodyText ?? ''}`,
          mode: 'reply'
        })
      }
      if (e.key === '/' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        document.querySelector<HTMLInputElement>('.search-input')?.focus()
      }
      if (e.key === 'Delete' && store.selectedMessageId) {
        window.orbitMail.messages.delete(store.selectedMessageId).then(() => {
          store.setSelectedMessage(null)
          store.setSelectedMessageId(null)
          refreshMessages()
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

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
