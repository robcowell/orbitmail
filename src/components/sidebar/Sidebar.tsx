import { useMemo, useState, useRef, useEffect, type MouseEvent as ReactMouseEvent } from 'react'
import type { Account, Folder, FolderType } from '../../../shared/types'
import { accountUnreadCount, shouldShowFolderUnreadBadge } from '../../../shared/folders'
import {
  useMailStore,
  selectFolder,
  removeAccountById,
  syncAccountById
} from '../../stores/mailStore'
import { AppBrand } from '../brand/AppBrand'
import { FolderContextMenu } from './FolderContextMenu'
import { AccountInfoDialog } from './AccountInfoDialog'
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

interface FolderContextTarget {
  folder: Folder
  account: Account
  x: number
  y: number
}

function FolderRow({
  folder,
  isActive,
  onSelect,
  onContextMenu
}: {
  folder: Folder
  isActive: boolean
  onSelect: () => void
  onContextMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void
}) {
  const Icon = FOLDER_ICON_MAP[folder.type]
  const colorClass = FOLDER_COLOR_CLASS[folder.type]

  return (
    <button
      className={`sidebar-item${isActive ? ' active' : ''}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
    >
      <Icon {...sidebarIconProps} className={`sidebar-item-icon ${colorClass}`} />
      <span className="sidebar-item-label">{folder.name}</span>
      {shouldShowFolderUnreadBadge(folder) && (
        <span className="sidebar-badge">{folder.unreadCount}</span>
      )}
    </button>
  )
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

function AccountSection({
  account,
  onFolderContextMenu
}: {
  account: Account
  onFolderContextMenu: (target: FolderContextTarget) => void
}) {
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

  const accountUnreadCountValue = useMemo(
    () => accountUnreadCount(account, folders),
    [account, folders]
  )

  const byType = (type: FolderType) => accountFolders.find((f) => f.type === type)
  const customFolders = accountFolders.filter((f) => f.type === 'custom')

  const openFolderMenu = (folder: Folder) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    onFolderContextMenu({
      folder,
      account,
      x: event.clientX,
      y: event.clientY
    })
  }

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
          {collapsed && accountUnreadCountValue > 0 && (
            <span className="sidebar-badge sidebar-account-badge" aria-label={`${accountUnreadCountValue} unread`}>
              {accountUnreadCountValue}
            </span>
          )}
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
            return (
              <FolderRow
                key={folder.id}
                folder={folder}
                isActive={selectedFolderId === folder.id}
                onSelect={() => selectFolder(folder.id)}
                onContextMenu={openFolderMenu(folder)}
              />
            )
          })}
          {customFolders.map((folder) => (
            <FolderRow
              key={folder.id}
              folder={folder}
              isActive={selectedFolderId === folder.id}
              onSelect={() => selectFolder(folder.id)}
              onContextMenu={openFolderMenu(folder)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function Sidebar() {
  const accounts = useMailStore((s) => s.accounts)
  const folders = useMailStore((s) => s.folders)
  const favoriteFolderIds = useMailStore((s) => s.favoriteFolderIds)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)
  const [folderMenu, setFolderMenu] = useState<FolderContextTarget | null>(null)
  const [accountInfoId, setAccountInfoId] = useState<string | null>(null)

  const favoriteFolders = useMemo(() => {
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    return favoriteFolderIds
      .map((id) => byId.get(id))
      .filter((folder): folder is Folder => Boolean(folder))
  }, [favoriteFolderIds, folders])

  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )

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

      {favoriteFolders.length > 0 && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">Favourites</div>
          {favoriteFolders.map((folder) => {
            const account = accountById.get(folder.accountId)
            if (!account) return null
            return (
              <FolderRow
                key={folder.id}
                folder={folder}
                isActive={selectedFolderId === folder.id}
                onSelect={() => selectFolder(folder.id)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setFolderMenu({
                    folder,
                    account,
                    x: event.clientX,
                    y: event.clientY
                  })
                }}
              />
            )
          })}
        </div>
      )}

      {accounts.map((account) => (
        <AccountSection
          key={account.id}
          account={account}
          onFolderContextMenu={setFolderMenu}
        />
      ))}

      <div className="sidebar-section">
        <button className="sidebar-item sidebar-item-accent" onClick={() => setShowAddAccount(true)}>
          <PlusCircle {...sidebarIconProps} className="sidebar-item-icon folder-icon-unified" />
          <span className="sidebar-item-label">Add Account</span>
        </button>
      </div>

      {folderMenu && (
        <FolderContextMenu
          folder={folderMenu.folder}
          account={folderMenu.account}
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          onShowAccountInfo={(accountId) => {
            setFolderMenu(null)
            setAccountInfoId(accountId)
          }}
        />
      )}

      {accountInfoId && (
        <AccountInfoDialog accountId={accountInfoId} onClose={() => setAccountInfoId(null)} />
      )}
    </div>
  )
}
