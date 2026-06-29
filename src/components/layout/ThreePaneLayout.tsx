import { ReactNode, useCallback, useEffect, useRef, useState } from 'react'

interface ThreePaneLayoutProps {
  sidebar: ReactNode
  list: ReactNode
  reader: ReactNode
}

const DEFAULT_SIDEBAR_WIDTH = 240
const DEFAULT_LIST_WIDTH = 320
const MIN_SIDEBAR_WIDTH = 180
const MIN_LIST_WIDTH = 200
const MIN_READER_WIDTH = 280
const DIVIDER_COUNT = 2

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

type DragTarget = 'sidebar' | 'list'

interface DragState {
  target: DragTarget
  startX: number
  startSidebarWidth: number
  startListWidth: number
}

export function ThreePaneLayout({ sidebar, list, reader }: ThreePaneLayoutProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH)
  const [listWidth, setListWidth] = useState(DEFAULT_LIST_WIDTH)

  const endDrag = useCallback(() => {
    dragRef.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }, [])

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current
      const container = containerRef.current
      if (!drag || !container) return

      const containerWidth = container.getBoundingClientRect().width
      const chrome = DIVIDER_COUNT
      const delta = event.clientX - drag.startX

      if (drag.target === 'sidebar') {
        const maxWidth =
          containerWidth - drag.startListWidth - MIN_READER_WIDTH - chrome
        setSidebarWidth(
          clamp(
            drag.startSidebarWidth + delta,
            MIN_SIDEBAR_WIDTH,
            Math.max(MIN_SIDEBAR_WIDTH, maxWidth)
          )
        )
        return
      }

      const maxWidth =
        containerWidth - drag.startSidebarWidth - MIN_READER_WIDTH - chrome
      setListWidth(
        clamp(
          drag.startListWidth + delta,
          MIN_LIST_WIDTH,
          Math.max(MIN_LIST_WIDTH, maxWidth)
        )
      )
    },
    []
  )

  useEffect(() => {
    const onPointerUp = () => endDrag()

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)

    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      endDrag()
    }
  }, [endDrag, onPointerMove])

  const startDrag =
    (target: DragTarget) => (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.currentTarget.setPointerCapture(event.pointerId)
      dragRef.current = {
        target,
        startX: event.clientX,
        startSidebarWidth: sidebarWidth,
        startListWidth: listWidth
      }
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

  return (
    <div
      ref={containerRef}
      className="three-pane"
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--list-width': `${listWidth}px`
        } as React.CSSProperties
      }
    >
      <div className="pane pane-sidebar">{sidebar}</div>
      <div
        className="pane-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        onPointerDown={startDrag('sidebar')}
      />
      <div className="pane pane-list">{list}</div>
      <div
        className="pane-divider"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize message list"
        onPointerDown={startDrag('list')}
      />
      <div className="pane pane-reader">{reader}</div>
    </div>
  )
}
