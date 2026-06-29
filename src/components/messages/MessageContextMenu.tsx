import { useMemo } from 'react'
import type { MessageSummary } from '../../../shared/types'
import { FLAG_COLORS } from '../../constants/flags'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { useMailStore } from '../../stores/mailStore'
import {
  archiveMessageById,
  blockSender,
  composeForMessage,
  deleteMessage,
  extractSenderEmail,
  folderActionItems,
  markRead,
  markUnread,
  moveToFolder,
  copyToFolder,
  muteSender,
  openMessage,
  setFlag
} from '../../utils/messageActions'
import {
  EnvelopeSimpleOpen,
  PaperPlaneTilt,
  ArrowBendUpLeft,
  ArrowBendDoubleUpLeft,
  ArrowBendUpRight,
  Paperclip,
  ShareNetwork,
  EnvelopeOpen,
  Envelope,
  BellSlash,
  Trash,
  Prohibit,
  Flag,
  Archive,
  ListChecks
} from '../icons'

interface MessageContextMenuProps {
  message: MessageSummary
  x: number
  y: number
  onClose: () => void
}

function FlagDot({ color }: { color: string }) {
  return <span className="flag-dot" style={{ backgroundColor: color }} />
}

export function MessageContextMenu({ message, x, y, onClose }: MessageContextMenuProps) {
  const folders = useMailStore((s) => s.folders)
  const setToast = useMailStore((s) => s.setToast)

  const run = (action: () => void | Promise<void>, successMessage?: string) => {
    void Promise.resolve(action())
      .then(() => {
        if (successMessage) setToast(successMessage)
      })
      .catch((err) => {
        setToast(err instanceof Error ? err.message : 'Action failed')
      })
  }

  const moveItems = useMemo(
    () =>
      folderActionItems(folders, message, 'move', (folderId) => {
        run(() => moveToFolder(message.id, folderId))
      }),
    [folders, message]
  )

  const copyItems = useMemo(
    () =>
      folderActionItems(folders, message, 'copy', (folderId) => {
        run(() => copyToFolder(message.id, folderId))
      }),
    [folders, message]
  )

  const flagItems: ContextMenuItem[] = [
    ...FLAG_COLORS.map((entry) => ({
      id: `flag-${entry.id}`,
      label: entry.label,
      icon: <FlagDot color={entry.hex} />,
      onClick: () => run(() => setFlag(message.id, entry.id))
    })),
    { id: 'flag-sep', label: '', separator: true, onClick: () => {} },
    {
      id: 'flag-clear',
      label: 'Clear Flag',
      disabled: !message.flagColor && !message.isStarred,
      icon: <Flag size={16} weight="duotone" />,
      onClick: () => run(() => setFlag(message.id, null))
    }
  ]

  const items: ContextMenuItem[] = [
    {
      id: 'open',
      label: 'Open',
      icon: <EnvelopeSimpleOpen size={16} weight="duotone" />,
      onClick: () => run(() => openMessage(message.id))
    },
    { id: 'sep-1', label: '', separator: true, onClick: () => {} },
    {
      id: 'send-again',
      label: 'Send Again',
      icon: <PaperPlaneTilt size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'send-again'))
    },
    {
      id: 'reply',
      label: 'Reply',
      icon: <ArrowBendUpLeft size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'reply'))
    },
    {
      id: 'reply-all',
      label: 'Reply All',
      icon: <ArrowBendDoubleUpLeft size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'reply-all'))
    },
    {
      id: 'forward',
      label: 'Forward',
      icon: <ArrowBendUpRight size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'forward'))
    },
    {
      id: 'forward-attachment',
      label: 'Forward as Attachment',
      icon: <Paperclip size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'forward-attachment'))
    },
    {
      id: 'redirect',
      label: 'Redirect',
      icon: <ShareNetwork size={16} weight="duotone" />,
      onClick: () => run(() => composeForMessage(message, 'redirect'))
    },
    { id: 'sep-2', label: '', separator: true, onClick: () => {} },
    {
      id: 'mark-read',
      label: 'Mark as Read',
      disabled: message.isRead,
      icon: <EnvelopeOpen size={16} weight="duotone" />,
      onClick: () => run(() => markRead(message.id))
    },
    {
      id: 'mark-unread',
      label: 'Mark as Unread',
      disabled: !message.isRead,
      icon: <Envelope size={16} weight="duotone" />,
      onClick: () => run(() => markUnread(message.id))
    },
    { id: 'sep-3', label: '', separator: true, onClick: () => {} },
    {
      id: 'mute',
      label: 'Mute',
      icon: <BellSlash size={16} weight="duotone" />,
      onClick: () =>
        run(
          () => muteSender(message),
          `Muted ${extractSenderEmail(message.from)}`
        )
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <Trash size={16} weight="duotone" />,
      onClick: () => run(() => deleteMessage(message.id))
    },
    {
      id: 'block',
      label: 'Block Sender',
      icon: <Prohibit size={16} weight="duotone" />,
      onClick: () =>
        run(
          () => blockSender(message),
          `Blocked ${extractSenderEmail(message.from)}`
        )
    },
    {
      id: 'flag',
      label: 'Flag',
      icon: <Flag size={16} weight="duotone" />,
      submenu: flagItems
    },
    {
      id: 'archive',
      label: 'Archive',
      icon: <Archive size={16} weight="duotone" />,
      onClick: () => run(() => archiveMessageById(message.id))
    },
    {
      id: 'move-to',
      label: 'Move to',
      submenu: moveItems.length ? moveItems : [{ id: 'move-empty', label: 'No folders', disabled: true, onClick: () => {} }]
    },
    {
      id: 'copy-to',
      label: 'Copy to',
      submenu: copyItems.length ? copyItems : [{ id: 'copy-empty', label: 'No folders', disabled: true, onClick: () => {} }]
    },
    { id: 'sep-4', label: '', separator: true, onClick: () => {} },
    {
      id: 'apply-rules',
      label: 'Apply Rules',
      disabled: true,
      icon: <ListChecks size={16} weight="duotone" />,
      onClick: () => {}
    }
  ]

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
