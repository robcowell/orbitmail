import type { AiPriority, CompletedTask, SweepScope, SweepTask } from '../../shared/types'

const PRIORITY_ORDER: AiPriority[] = ['urgent', 'high', 'medium', 'low']
const PRIORITY_HEADING: Record<AiPriority, string> = {
  urgent: 'Urgent',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority'
}

export interface TaskExportData {
  tasks: SweepTask[]
  completed: CompletedTask[]
  scope: SweepScope
  analyzedCount: number
  sweptAt: number | null
}

// Flatten to a single line and defuse characters that would break a Markdown
// list item.
function clean(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim()
}

function line(task: SweepTask, done: boolean, suffix = ''): string {
  const box = done ? '[x]' : '[ ]'
  const source = clean(`${task.sourceFrom} — ${task.sourceSubject}`)
  return `- ${box} ${clean(task.task)} _(${source})_${suffix}`
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// Render the current sweep as a Markdown checklist grouped by priority, with a
// completed section at the end.
export function buildTasksMarkdown(data: TaskExportData): string {
  const { tasks, completed, scope, analyzedCount, sweptAt } = data
  const scopeLabel = scope === 'all' ? 'message' : 'unread message'
  const countLabel = `${analyzedCount} ${scopeLabel}${analyzedCount === 1 ? '' : 's'}`

  const lines: string[] = ['# Outstanding Tasks', '']

  const meta = [
    `Scope: ${scope === 'all' ? 'All messages' : 'Unread'}`,
    `Reviewed ${countLabel}`,
    sweptAt ? `Swept ${formatDate(sweptAt)}` : null
  ]
    .filter(Boolean)
    .join(' · ')
  lines.push(`_${meta}_`, '')

  if (tasks.length === 0) {
    lines.push('No outstanding tasks. 🎉', '')
  } else {
    for (const priority of PRIORITY_ORDER) {
      const items = tasks.filter((t) => t.priority === priority)
      if (items.length === 0) continue
      lines.push(`## ${PRIORITY_HEADING[priority]}`)
      for (const task of items) lines.push(line(task, false))
      lines.push('')
    }
  }

  if (completed.length > 0) {
    lines.push(`## Completed (${completed.length})`)
    for (const task of completed) {
      lines.push(line(task, true, ` — done ${formatDate(task.completedAt)}`))
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// Suggested filename, e.g. tasks-2026-07-05.md.
export function defaultTasksFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10)
  return `tasks-${stamp}.md`
}
