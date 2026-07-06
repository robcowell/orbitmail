import { useMemo } from 'react'
import type { MessageSummary } from '../../../shared/types'
import { ContextMenu } from '../ui/ContextMenu'
import { useMailStore } from '../../stores/mailStore'
import {
  archiveMessageById,
  blockSender,
  composeForMessage,
  deleteMessage,
  markRead,
  markUnread,
  moveToFolder,
  copyToFolder,
  muteSender,
  openMessage,
  setFlag
} from '../../utils/messageActions'
import { buildMailMenuItems } from './mailMenu'

interface MessageContextMenuProps {
  message: MessageSummary
  x: number
  y: number
  onClose: () => void
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

  const items = useMemo(
    () =>
      buildMailMenuItems(
        folders,
        {
          from: message.from,
          isRead: message.isRead,
          isStarred: message.isStarred,
          flagColor: message.flagColor,
          accountId: message.accountId,
          excludeFolderId: message.folderId
        },
        {
          open: () => openMessage(message.id),
          compose: (mode) => composeForMessage(message, mode),
          markRead: () => markRead(message.id),
          markUnread: () => markUnread(message.id),
          mute: () => muteSender(message),
          block: () => blockSender(message),
          del: () => deleteMessage(message.id),
          setFlag: (color) => setFlag(message.id, color),
          archive: () => archiveMessageById(message.id),
          move: (folderId) => moveToFolder(message.id, folderId),
          copy: (folderId) => copyToFolder(message.id, folderId)
        },
        run
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, message]
  )

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
