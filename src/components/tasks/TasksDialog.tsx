import type { AiPriority, SweepScope, SweepTask } from '../../../shared/types'
import {
  useMailStore,
  selectMessage,
  runSweep,
  completeTask,
  reopenTask
} from '../../stores/mailStore'

interface TasksDialogProps {
  onClose: () => void
}

const PRIORITY_ORDER: AiPriority[] = ['urgent', 'high', 'medium', 'low']
const PRIORITY_LABEL: Record<AiPriority, string> = {
  urgent: 'Urgent',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority'
}

const SCOPE_OPTIONS: { value: SweepScope; label: string }[] = [
  { value: 'unread', label: 'Unread' },
  { value: 'all', label: 'All messages' }
]

function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.round(hrs / 24)
  return `${days}d ago`
}

export function TasksDialog({ onClose }: TasksDialogProps) {
  const sweeping = useMailStore((s) => s.sweeping)
  const tasks = useMailStore((s) => s.sweepTasks)
  const completed = useMailStore((s) => s.sweepCompleted)
  const analyzedCount = useMailStore((s) => s.sweepAnalyzedCount)
  const scope = useMailStore((s) => s.sweepScope)
  const setSweepScope = useMailStore((s) => s.setSweepScope)
  const sweptAt = useMailStore((s) => s.sweepSweptAt)

  const handleOpen = (task: SweepTask) => {
    void selectMessage(task.sourceMessageId)
    onClose()
  }

  const grouped = PRIORITY_ORDER.map((priority) => ({
    priority,
    items: tasks.filter((t) => t.priority === priority)
  })).filter((g) => g.items.length > 0)

  const hasSwept = sweptAt !== null
  const scopeLabel = scope === 'all' ? 'message' : 'unread message'

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tasks-modal" onClick={(event) => event.stopPropagation()}>
        <div className="tasks-modal-head">
          <h2>Outstanding Tasks</h2>
          <div className="tasks-controls">
            <div className="tasks-scope" role="group" aria-label="Which messages to scan">
              {SCOPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`tasks-scope-btn${scope === opt.value ? ' is-active' : ''}`}
                  aria-pressed={scope === opt.value}
                  disabled={sweeping}
                  onClick={() => setSweepScope(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="reader-ai-regenerate"
              disabled={sweeping}
              onClick={() => void runSweep(scope)}
            >
              {hasSwept ? 'Re-sweep' : 'Sweep'}
            </button>
          </div>
        </div>

        {sweeping ? (
          <p className="tasks-loading">Reviewing {scope === 'all' ? 'your mail' : 'unread mail'} for outstanding tasks…</p>
        ) : !hasSwept ? (
          <p className="account-hint">
            Scan your {scope === 'all' ? 'mail' : 'unread mail'} in this folder for the things you
            still need to act on. Choose a scope above and press Sweep.
          </p>
        ) : (
          <>
            {sweptAt !== null && (
              <p className="tasks-subhead">
                {tasks.length === 0
                  ? analyzedCount === 0
                    ? `No ${scopeLabel}s in this folder to review.`
                    : `No outstanding tasks across ${analyzedCount} ${scopeLabel}${analyzedCount === 1 ? '' : 's'}.`
                  : `${tasks.length} task${tasks.length === 1 ? '' : 's'} across ${analyzedCount} ${scopeLabel}${analyzedCount === 1 ? '' : 's'}.`}{' '}
                <span className="tasks-swept-at">Swept {timeAgo(sweptAt)}.</span>
              </p>
            )}

            {(tasks.length > 0 || completed.length > 0) && (
              <div className="tasks-list">
                {grouped.map((group) => (
                  <div key={group.priority} className="tasks-group">
                    <div className={`tasks-group-title priority-${group.priority}`}>
                      {PRIORITY_LABEL[group.priority]}
                    </div>
                    {group.items.map((task) => (
                      <div key={task.id} className="tasks-item">
                        <button
                          type="button"
                          className="tasks-check"
                          title="Mark done"
                          aria-label="Mark done"
                          onClick={() => void completeTask(task.id)}
                        />
                        <button
                          type="button"
                          className="tasks-item-body"
                          onClick={() => handleOpen(task)}
                          title="Open source email"
                        >
                          <span className="tasks-item-text">{task.task}</span>
                          <span className="tasks-item-source">
                            {task.sourceFrom} — {task.sourceSubject}
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                ))}

                {completed.length > 0 && (
                  <div className="tasks-group tasks-completed">
                    <div className="tasks-group-title tasks-completed-title">
                      Completed ({completed.length})
                    </div>
                    {completed.map((task) => (
                      <div key={task.id} className="tasks-item is-done">
                        <button
                          type="button"
                          className="tasks-check is-checked"
                          title="Undo"
                          aria-label="Reopen task"
                          onClick={() => void reopenTask(task.id)}
                        />
                        <button
                          type="button"
                          className="tasks-item-body"
                          onClick={() => handleOpen(task)}
                          title="Open source email"
                        >
                          <span className="tasks-item-text">{task.task}</span>
                          <span className="tasks-item-source">
                            {task.sourceFrom} — {task.sourceSubject}
                          </span>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
