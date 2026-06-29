import { useMemo, useState, useRef, useEffect } from 'react'
import type { Account, FolderType } from '../../../shared/types'
import {
  useMailStore,
  selectFolder,
  removeAccountById,
  syncAccountById
} from '../../stores/mailStore'
import { AppBrand } from '../brand/AppBrand'
import {
  sidebarIconProps,
  FOLDER_ICON_MAP,
  FOLDER_COLOR_CLASS,
  TrayArrowDown,
  PlusCircle,
  GearSix,
  ArrowsClockwise,
  Trash
} from '../icons'

const STANDARD_TYPES: FolderType[] = ['inbox', 'sent', 'drafts', 'trash', 'junk']

function accountLabel(account: Account): string {
  if (account.displayName === account.email) return account.email
  return `${account.displayName} (${account.email})`
}

function AccountMenu({
  account,
  onClose
}: {
  account: Account
  onClose: () => void
}) {
  const handleSync = async () => {
    onClose()
    await syncAccountById(account.id)
  }

  const handleRemove = async () => {
    onClose()
    const confirmed = window.confirm(
      `Remove ${account.email}? Local cached mail for this account will be deleted.`
    )
    if (!confirmed) return
    await removeAccountById(account.id)
  }

  return (
    <div className="account-menu">
      <button type="button" className="account-menu-item" onClick={handleSync}>
        <ArrowsClockwise size={14} weight="duotone" />
        Sync now
      </button>
      <button type="button" className="account-menu-item danger" onClick={handleRemove}>
        <Trash size={14} weight="duotone" />
        Remove account
      </button>
    </div>
  )
}

function AccountSection({ account }: { account: Account }) {
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const collapsed = useMailStore((s) => s.collapsedAccountIds[account.id] ?? false)
  const toggleAccountCollapsed = useMailStore((s) => s.toggleAccountCollapsed)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [menuOpen])

  const accountFolders = useMemo(
    () => folders.filter((f) => f.accountId === account.id),
    [folders, account.id]
  )

  const byType = (type: FolderType) => accountFolders.find((f) => f.type === type)
  const customFolders = accountFolders.filter((f) => f.type === 'custom')

  return (
    <div className="sidebar-section">
      <div className="sidebar-account-header-row">
        <button
          type="button"
          className="sidebar-account-header"
          onClick={() => toggleAccountCollapsed(account.id)}
          aria-expanded={!collapsed}
        >
          <span className="sidebar-account-label">{accountLabel(account)}</span>
        </button>
        <div className="account-menu-wrap" ref={menuRef}>
          <button
            type="button"
            className="sidebar-account-menu-btn"
            title="Account settings"
            aria-label="Account settings"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <GearSix size={14} weight="duotone" />
          </button>
          {menuOpen && (
            <AccountMenu account={account} onClose={() => setMenuOpen(false)} />
          )}
        </div>
      </div>

      {!collapsed && (
        <div className="sidebar-account-folders">
          {STANDARD_TYPES.map((type) => {
            const folder = byType(type)
            if (!folder) return null
            const Icon = FOLDER_ICON_MAP[type]
            const isActive = selectedFolderId === folder.id
            return (
              <button
                key={folder.id}
                className={`sidebar-item${isActive ? ' active' : ''}`}
                onClick={() => selectFolder(folder.id)}
              >
                <Icon
                  {...sidebarIconProps}
                  className={`sidebar-item-icon ${FOLDER_COLOR_CLASS[type]}`}
                />
                <span className="sidebar-item-label">{folder.name}</span>
                {folder.unreadCount > 0 && (
                  <span className="sidebar-badge">{folder.unreadCount}</span>
                )}
              </button>
            )
          })}
          {customFolders.map((folder) => (
            <button
              key={folder.id}
              className={`sidebar-item${selectedFolderId === folder.id ? ' active' : ''}`}
              onClick={() => selectFolder(folder.id)}
            >
              <FOLDER_ICON_MAP.custom
                {...sidebarIconProps}
                className={`sidebar-item-icon ${FOLDER_COLOR_CLASS.custom}`}
              />
              <span className="sidebar-item-label">{folder.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const accounts = useMailStore((s) => s.accounts)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)

  return (
    <div>
      <div className="sidebar-brand">
        <AppBrand />
      </div>

      <div className="sidebar-section">
        <button
          className={`sidebar-item${selectedFolderId === 'unified' ? ' active' : ''}`}
          onClick={() => selectFolder('unified')}
        >
          <TrayArrowDown
            {...sidebarIconProps}
            className="sidebar-item-icon folder-icon-unified"
          />
          <span className="sidebar-item-label">All Inboxes</span>
        </button>
      </div>

      {accounts.map((account) => (
        <AccountSection key={account.id} account={account} />
      ))}

      <div className="sidebar-section">
        <button className="sidebar-item sidebar-item-accent" onClick={() => setShowAddAccount(true)}>
          <PlusCircle {...sidebarIconProps} className="sidebar-item-icon folder-icon-unified" />
          <span className="sidebar-item-label">Add Account</span>
        </button>
      </div>
    </div>
  )
}
