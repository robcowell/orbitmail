import {
  Inbox,
  Send,
  FileText,
  Trash2,
  AlertOctagon,
  Folder,
  Plus,
  Mail
} from 'lucide-react'
import type { FolderType } from '../../../shared/types'
import { useMailStore, selectFolder } from '../../stores/mailStore'

const FOLDER_ICONS: Record<FolderType, typeof Inbox> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileText,
  trash: Trash2,
  junk: AlertOctagon,
  custom: Folder
}

export function Sidebar() {
  const accounts = useMailStore((s) => s.accounts)
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const setShowAddAccount = useMailStore((s) => s.setShowAddAccount)

  const standardTypes: FolderType[] = ['inbox', 'sent', 'drafts', 'trash', 'junk']

  return (
    <div>
      <div className="sidebar-section">
        <button
          className="sidebar-item"
          onClick={() => selectFolder('unified')}
          style={{ fontWeight: selectedFolderId === 'unified' ? 600 : 400 }}
        >
          <Mail size={16} className="sidebar-item-icon" />
          <span className="sidebar-item-label">All Inboxes</span>
        </button>
      </div>

      {accounts.map((account) => {
        const accountFolders = folders.filter((f) => f.accountId === account.id)
        const byType = (type: FolderType) =>
          accountFolders.find((f) => f.type === type)

        return (
          <div className="sidebar-section" key={account.id}>
            <div className="sidebar-section-title">{account.displayName}</div>
            {standardTypes.map((type) => {
              const folder = byType(type)
              if (!folder) return null
              const Icon = FOLDER_ICONS[type]
              const isActive = selectedFolderId === folder.id
              return (
                <button
                  key={folder.id}
                  className={`sidebar-item${isActive ? ' active' : ''}`}
                  onClick={() => selectFolder(folder.id)}
                >
                  <Icon size={16} className="sidebar-item-icon" />
                  <span className="sidebar-item-label">{folder.name}</span>
                  {folder.unreadCount > 0 && (
                    <span className="sidebar-badge">{folder.unreadCount}</span>
                  )}
                </button>
              )
            })}
            {accountFolders
              .filter((f) => f.type === 'custom')
              .map((folder) => (
                <button
                  key={folder.id}
                  className={`sidebar-item${selectedFolderId === folder.id ? ' active' : ''}`}
                  onClick={() => selectFolder(folder.id)}
                >
                  <Folder size={16} className="sidebar-item-icon" />
                  <span className="sidebar-item-label">{folder.name}</span>
                </button>
              ))}
          </div>
        )
      })}

      <div className="sidebar-section">
        <button className="sidebar-item" onClick={() => setShowAddAccount(true)}>
          <Plus size={16} className="sidebar-item-icon" />
          <span className="sidebar-item-label">Add Account</span>
        </button>
      </div>
    </div>
  )
}
