import {
  useMailStore,
  toggleThreadedView,
  toggleUnreadFilter,
  isUnreadOnlyView,
  openTasksDialog
} from '../../stores/mailStore'
import { iconProps, Funnel, Stack, ListChecks, Sparkle } from '../icons'

// Per-view controls for the message list — filtering, grouping, and the mail
// digests that act on whatever the list is currently showing. Sits directly
// above the scrollable list rather than in the global window toolbar.
export function MessageListHeader() {
  const threadedView = useMailStore((s) => s.threadedView)
  const unreadOnly = useMailStore(isUnreadOnlyView)

  return (
    <div className="list-toolbar">
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
        onClick={() => useMailStore.getState().setShowAiSettings(true)}
      >
        <Sparkle {...iconProps} />
      </button>
    </div>
  )
}
