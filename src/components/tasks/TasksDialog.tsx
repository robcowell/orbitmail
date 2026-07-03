import type { AiPriority, SweepTask } from '../../../shared/types'
import { useMailStore, selectMessage, runSweep } from '../../stores/mailStore'

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

export function TasksDialog({ onClose }: TasksDialogProps) {
  const sweeping = useMailStore((s) => s.sweeping)
  const tasks = useMailStore((s) => s.sweepTasks)
  const analyzedCount = useMailStore((s) => s.sweepAnalyzedCount)

  const handleOpen = (task: SweepTask) => {
    void selectMessage(task.sourceMessageId)
    onClose()
  }

  const grouped = PRIORITY_ORDER.map((priority) => ({
    priority,
    items: tasks.filter((t) => t.priority === priority)
  })).filter((g) => g.items.length > 0)

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tasks-modal" onClick={(event) => event.stopPropagation()}>
        <div className="tasks-modal-head">
          <h2>Outstanding Tasks</h2>
          {!sweeping && (
            <button
              type="button"
              className="reader-ai-regenerate"
              onClick={() => void runSweep()}
            >
              Re-sweep
            </button>
          )}
        </div>

        {sweeping ? (
          <p className="tasks-loading">Reviewing unread mail for outstanding tasks…</p>
        ) : tasks.length === 0 ? (
          <p className="account-hint">
            {analyzedCount === 0
              ? 'No unread messages in this folder to review.'
              : `No outstanding tasks found across ${analyzedCount} unread message${analyzedCount === 1 ? '' : 's'}.`}
          </p>
        ) : (
          <>
            <p className="tasks-subhead">
              {tasks.length} task{tasks.length === 1 ? '' : 's'} across {analyzedCount} unread
              message{analyzedCount === 1 ? '' : 's'}
            </p>
            <div className="tasks-list">
              {grouped.map((group) => (
                <div key={group.priority} className="tasks-group">
                  <div className={`tasks-group-title priority-${group.priority}`}>
                    {PRIORITY_LABEL[group.priority]}
                  </div>
                  {group.items.map((task, i) => (
                    <button
                      key={`${group.priority}-${i}`}
                      type="button"
                      className="tasks-item"
                      onClick={() => handleOpen(task)}
                      title="Open source email"
                    >
                      <span className="tasks-item-text">{task.task}</span>
                      <span className="tasks-item-source">
                        {task.sourceFrom} — {task.sourceSubject}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
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
