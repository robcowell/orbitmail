import type { Account, Folder } from '../../../shared/types'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { useMailStore } from '../../stores/mailStore'
import {
  createMailboxForAccount,
  emptyJunkForAccount,
  emptyTrashForAccount,
  exportMailbox,
  markAllReadInFolder,
  syncAccountById,
  updateAccountDisplayName
} from '../../stores/mailStore'
import {
  FolderPlus,
  Star,
  Export,
  Trash,
  WarningCircle,
  EnvelopeOpen,
  ArrowsClockwise,
  PencilSimple,
  Info
} from '../icons'

interface FolderContextMenuProps {
  folder: Folder
  account: Account
  x: number
  y: number
  onClose: () => void
  onShowAccountInfo: (accountId: string) => void
}

function accountShortName(account: Account): string {
  return account.displayName.trim() || account.email
}

export function FolderContextMenu({
  folder,
  account,
  x,
  y,
  onClose,
  onShowAccountInfo
}: FolderContextMenuProps) {
  const favoriteFolderIds = useMailStore((s) => s.favoriteFolderIds)
  const folders = useMailStore((s) => s.folders)
  const toggleFavoriteFolder = useMailStore((s) => s.toggleFavoriteFolder)
  const setToast = useMailStore((s) => s.setToast)

  const isFavorite = favoriteFolderIds.includes(folder.id)
  const isPop3 = account.provider === 'pop3'
  const hasTrash = folders.some((f) => f.accountId === account.id && f.type === 'trash')
  const hasJunk = folders.some((f) => f.accountId === account.id && f.type === 'junk')
  const accountName = accountShortName(account)

  const run = (action: () => void | Promise<void>) => {
    void Promise.resolve(action()).catch((err) => {
      setToast(err instanceof Error ? err.message : 'Action failed')
    })
  }

  const items: ContextMenuItem[] = [
    {
      id: 'new-mailbox',
      label: 'New Mailbox',
      disabled: isPop3,
      icon: <FolderPlus size={16} weight="duotone" />,
      onClick: () => {
        const name = window.prompt('New mailbox name:')
        if (!name?.trim()) return
        run(() => createMailboxForAccount(account.id, name))
      }
    },
    {
      id: 'favourite',
      label: isFavorite ? 'Remove from Favourites' : 'Add to Favourites',
      icon: <Star size={16} weight={isFavorite ? 'fill' : 'duotone'} />,
      onClick: () => toggleFavoriteFolder(folder.id)
    },
    {
      id: 'export',
      label: 'Export Mailbox',
      disabled: isPop3,
      icon: <Export size={16} weight="duotone" />,
      onClick: () => run(() => exportMailbox(folder.id))
    },
    { id: 'sep-1', label: '', separator: true, onClick: () => {} },
    {
      id: 'empty-trash',
      label: 'Erase Deleted Items',
      disabled: !hasTrash,
      icon: <Trash size={16} weight="duotone" />,
      onClick: () => {
        if (
          !window.confirm(
            `Permanently erase all messages in Trash for ${account.email}? This cannot be undone.`
          )
        ) {
          return
        }
        run(() => emptyTrashForAccount(account.id))
      }
    },
    {
      id: 'empty-junk',
      label: 'Erase Junk Mail',
      disabled: !hasJunk,
      icon: <WarningCircle size={16} weight="duotone" />,
      onClick: () => {
        if (
          !window.confirm(
            `Permanently erase all messages in Junk for ${account.email}? This cannot be undone.`
          )
        ) {
          return
        }
        run(() => emptyJunkForAccount(account.id))
      }
    },
    {
      id: 'mark-all-read',
      label: 'Mark all messages as read',
      icon: <EnvelopeOpen size={16} weight="duotone" />,
      onClick: () => run(() => markAllReadInFolder(folder.id))
    },
    { id: 'sep-2', label: '', separator: true, onClick: () => {} },
    {
      id: 'sync',
      label: `Synchronise ${accountName}`,
      icon: <ArrowsClockwise size={16} weight="duotone" />,
      onClick: () => run(() => syncAccountById(account.id))
    },
    {
      id: 'edit',
      label: `Edit ${accountName}`,
      icon: <PencilSimple size={16} weight="duotone" />,
      onClick: () => {
        const next = window.prompt('Account display name:', account.displayName)
        if (!next?.trim() || next.trim() === account.displayName) return
        run(() => updateAccountDisplayName(account.id, next))
      }
    },
    {
      id: 'account-info',
      label: 'Get Account Info',
      icon: <Info size={16} weight="duotone" />,
      onClick: () => onShowAccountInfo(account.id)
    }
  ]

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
