import { ReactNode } from 'react'

interface ThreePaneLayoutProps {
  sidebar: ReactNode
  list: ReactNode
  reader: ReactNode
}

export function ThreePaneLayout({ sidebar, list, reader }: ThreePaneLayoutProps) {
  return (
    <div className="three-pane">
      <div className="pane pane-sidebar">{sidebar}</div>
      <div className="pane-divider" />
      <div className="pane pane-list">{list}</div>
      <div className="pane-divider" />
      <div className="pane pane-reader">{reader}</div>
    </div>
  )
}
