import type { Account, Folder } from '../../../shared/types'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { accountShortName } from '../../utils/accounts'
import { useMailStore } from '../../stores/mailStore'
import {
  createMailboxForAccount,
  emptyJunkForAccount,
  emptyTrashForAccount,
  exportMailbox,
  markAllReadInFolder,
  syncAccountById
} from '../../stores/mailStore'
import {
  FolderPlus,
  Star,
  Export,
  Trash,
  WarningCircle,
  EnvelopeOpen,
  ArrowsClockwise,
  GearSix
} from '../icons'
import { ipcErrorMessage } from '../../utils/ipcError'

interface FolderContextMenuProps {
  folder: Folder
  account: Account
  x: number
  y: number
  onClose: () => void
  onOpenAccountSettings: (accountId: string) => void
}

export function FolderContextMenu({
  folder,
  account,
  x,
  y,
  onClose,
  onOpenAccountSettings
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
      setToast(ipcErrorMessage(err, 'Action failed'))
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
      // Renaming and the account's details are both in Settings → Accounts now.
      // Renaming used to be a window.prompt, which cannot validate, cannot say
      // what the name is for, and looks nothing like the rest of the app.
      id: 'account-settings',
      label: `${accountName} settings…`,
      icon: <GearSix size={16} weight="duotone" />,
      onClick: () => onOpenAccountSettings(account.id)
    }
  ]

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
