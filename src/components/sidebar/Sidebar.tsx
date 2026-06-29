import { useMemo } from 'react'
import type { Account, FolderType } from '../../../shared/types'
import { useMailStore, selectFolder } from '../../stores/mailStore'
import { AppBrand } from '../brand/AppBrand'
import {
  sidebarIconProps,
  FOLDER_ICON_MAP,
  FOLDER_COLOR_CLASS,
  TrayArrowDown,
  PlusCircle
} from '../icons'

const STANDARD_TYPES: FolderType[] = ['inbox', 'sent', 'drafts', 'trash', 'junk']

function accountLabel(account: Account): string {
  if (account.displayName === account.email) return account.email
  return `${account.displayName} (${account.email})`
}

function AccountSection({ account }: { account: Account }) {
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const collapsed = useMailStore((s) => s.collapsedAccountIds[account.id] ?? false)
  const toggleAccountCollapsed = useMailStore((s) => s.toggleAccountCollapsed)

  const accountFolders = useMemo(
    () => folders.filter((f) => f.accountId === account.id),
    [folders, account.id]
  )

  const byType = (type: FolderType) => accountFolders.find((f) => f.type === type)
  const customFolders = accountFolders.filter((f) => f.type === 'custom')

  return (
    <div className="sidebar-section">
      <button
        type="button"
        className="sidebar-account-header"
        onClick={() => toggleAccountCollapsed(account.id)}
        aria-expanded={!collapsed}
      >
        <span className="sidebar-account-label">{accountLabel(account)}</span>
      </button>

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
