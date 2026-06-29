import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { CaretRight } from '../icons'

export interface ContextMenuItem {
  id: string
  label: string
  onClick?: () => void
  disabled?: boolean
  separator?: boolean
  icon?: ReactNode
  submenu?: ContextMenuItem[]
}

interface ContextMenuProps {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}

function ContextMenuPanel({
  items,
  onClose,
  className,
  style,
  onMouseLeave
}: {
  items: ContextMenuItem[]
  onClose: () => void
  className?: string
  style?: React.CSSProperties
  onMouseLeave?: () => void
}) {
  const [openSubmenuId, setOpenSubmenuId] = useState<string | null>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  return (
    <div
      className={className ?? 'context-menu'}
      style={style}
      role="menu"
      onContextMenu={(event) => event.preventDefault()}
      onMouseLeave={onMouseLeave}
    >
      {items.map((item) => {
        if (item.separator) {
          return <div key={item.id} className="context-menu-separator" role="separator" />
        }

        const hasSubmenu = Boolean(item.submenu?.length)

        return (
          <div key={item.id} className="context-menu-item-wrap">
            <button
              ref={(node) => {
                itemRefs.current[item.id] = node
              }}
              type="button"
              className={[
                'context-menu-item',
                hasSubmenu ? 'has-submenu' : '',
                openSubmenuId === item.id ? 'submenu-open' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              role="menuitem"
              aria-haspopup={hasSubmenu ? 'menu' : undefined}
              aria-expanded={hasSubmenu ? openSubmenuId === item.id : undefined}
              disabled={item.disabled}
              onMouseEnter={() => {
                if (hasSubmenu && !item.disabled) {
                  setOpenSubmenuId(item.id)
                } else {
                  setOpenSubmenuId(null)
                }
              }}
              onClick={() => {
                if (item.disabled || hasSubmenu) return
                item.onClick?.()
                onClose()
              }}
            >
              <span className="context-menu-item-main">
                {item.icon ? <span className="context-menu-icon">{item.icon}</span> : null}
                <span className="context-menu-label">{item.label}</span>
              </span>
              {hasSubmenu ? (
                <CaretRight size={12} weight="bold" className="context-menu-caret" />
              ) : null}
            </button>

            {hasSubmenu && openSubmenuId === item.id && item.submenu ? (
              <ContextMenuPanel
                items={item.submenu}
                onClose={onClose}
                className="context-menu context-submenu"
                style={{
                  position: 'absolute',
                  top: itemRefs.current[item.id]?.offsetTop ?? 0,
                  left: '100%',
                  marginLeft: '4px'
                }}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handlePointer = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('mousedown', handlePointer)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('keydown', handleKey)
    window.addEventListener('resize', onClose)

    return () => {
      window.removeEventListener('mousedown', handlePointer)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('keydown', handleKey)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  useEffect(() => {
    const menu = menuRef.current
    if (!menu) return

    const rect = menu.getBoundingClientRect()
    const padding = 8
    let left = x
    let top = y

    if (left + rect.width > window.innerWidth - padding) {
      left = Math.max(padding, window.innerWidth - rect.width - padding)
    }
    if (top + rect.height > window.innerHeight - padding) {
      top = Math.max(padding, window.innerHeight - rect.height - padding)
    }

    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [x, y, items])

  return createPortal(
    <div ref={menuRef} className="context-menu-root" style={{ left: x, top: y }}>
      <ContextMenuPanel items={items} onClose={onClose} />
    </div>,
    document.body
  )
}
