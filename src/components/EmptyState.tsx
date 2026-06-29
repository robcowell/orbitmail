import type { ReactNode } from 'react'
import { Planet } from './icons'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
}

export function EmptyState({ icon, title, description }: EmptyStateProps) {
  return (
    <div className="reader-empty">
      <div className="empty-state-icon">{icon ?? <Planet size={40} weight="duotone" />}</div>
      <div className="empty-state-title">{title}</div>
      {description && <p>{description}</p>}
    </div>
  )
}
