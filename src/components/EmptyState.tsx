import type { ReactNode } from 'react'
import { Planet } from './icons'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  // Optional recovery action — used when the pane is empty because something
  // failed, rather than because nothing is selected.
  action?: { label: string; onClick: () => void }
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="reader-empty">
      <div className="empty-state-icon">{icon ?? <Planet size={40} weight="duotone" />}</div>
      <div className="empty-state-title">{title}</div>
      {description && <p>{description}</p>}
      {action && (
        <button type="button" className="btn btn-secondary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
