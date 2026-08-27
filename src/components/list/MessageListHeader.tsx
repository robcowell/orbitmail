import {
  useMailStore,
  toggleThreadedView,
  toggleUnreadFilter,
  isUnreadOnlyView,
  openTasksDialog,
  openSettings
} from '../../stores/mailStore'
import { iconProps, Funnel, Stack, ListChecks, Sparkle } from '../icons'
import { describeListHeader } from '../../utils/listHeader'

// Per-view controls for the message list — filtering, grouping, and the mail
// digests that act on whatever the list is currently showing. Sits directly
// above the scrollable list rather than in the global window toolbar.
export function MessageListHeader() {
  const threadedView = useMailStore((s) => s.threadedView)
  const unreadOnly = useMailStore(isUnreadOnlyView)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const folders = useMailStore((s) => s.folders)
  const accounts = useMailStore((s) => s.accounts)
  const threads = useMailStore((s) => s.threads)
  const messages = useMailStore((s) => s.messages)
  const threadTotal = useMailStore((s) => s.threadTotal)
  const messageTotal = useMailStore((s) => s.messageTotal)
  const searchQuery = useMailStore((s) => s.searchQuery)

  const searching = searchQuery.trim().length > 0
  const header = describeListHeader({
    selectedFolderId,
    folders,
    accounts,
    threadedView,
    unreadOnly,
    loaded: threadedView ? threads.length : messages.length,
    total: threadedView ? threadTotal : messageTotal,
    searching
  })

  return (
    <div className="list-toolbar">
      {/* Words, not just toggles: which folder, how much of it is loaded, and
          whether a filter is hiding the rest. */}
      <div className="list-toolbar-heading">
        <div className="list-toolbar-title">
          <span className="list-toolbar-folder">{header.title}</span>
          {header.subtitle && (
            <span className="list-toolbar-account">{header.subtitle}</span>
          )}
        </div>
        <div className="list-toolbar-counts">
          {searching ? (
            <span>Search results</span>
          ) : (
            <>
              <span>{header.count}</span>
              {header.unread && <span className="list-toolbar-unread">{header.unread}</span>}
            </>
          )}
        </div>
      </div>
      <div className="list-toolbar-actions">
      <button
        className={`toolbar-btn${unreadOnly ? ' active' : ''}`}
        title={unreadOnly ? 'Showing unread only — click to show all' : 'Show unread only'}
        aria-pressed={unreadOnly}
        onClick={() => void toggleUnreadFilter()}
      >
        <Funnel {...iconProps} weight={unreadOnly ? 'fill' : 'duotone'} />
      </button>

      <button
        className={`toolbar-btn${threadedView ? ' active' : ''}`}
        title={threadedView ? 'Conversation view on — click for flat list' : 'Group by conversation'}
        aria-pressed={threadedView}
        onClick={() => void toggleThreadedView()}
      >
        <Stack {...iconProps} weight={threadedView ? 'fill' : 'duotone'} />
      </button>

      <button
        className="toolbar-btn"
        title="Tasks from your mail"
        onClick={() => void openTasksDialog()}
      >
        <ListChecks {...iconProps} />
      </button>

      <button
        className="toolbar-btn"
        title="AI settings"
        onClick={() => openSettings('ai')}
      >
        <Sparkle {...iconProps} />
      </button>
      </div>
    </div>
  )
}
