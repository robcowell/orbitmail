import { useMemo } from 'react'
import type { MessageSummary } from '../../../shared/types'
import { ContextMenu } from '../ui/ContextMenu'
import {
  useMailStore,
  flagMessageAsTask,
  deleteSelectedMessages,
  archiveSelectedMessages,
  moveSelectedMessagesToFolder
} from '../../stores/mailStore'
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
import { printMessageById } from '../../utils/printMessage'
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
  const selectedMessageIds = useMailStore((s) => s.selectedMessageIds)

  // Right-clicking inside a multi-selection acts on the whole selection;
  // right-clicking outside it acts on that row alone, as the click would.
  const inSelection = selectedMessageIds.length > 1 && selectedMessageIds.includes(message.id)
  const selectionCount = inSelection ? selectedMessageIds.length : 1

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
          excludeFolderId: message.folderId,
          selectionCount
        },
        {
          open: () => openMessage(message.id),
          compose: (mode) => composeForMessage(message, mode),
          markRead: () => markRead(message.id),
          markUnread: () => markUnread(message.id),
          mute: () => muteSender(message),
          block: () => blockSender(message),
          del: () => (inSelection ? deleteSelectedMessages() : deleteMessage(message.id)),
          setFlag: (color) => setFlag(message.id, color),
          archive: () =>
            inSelection ? archiveSelectedMessages() : archiveMessageById(message.id),
          move: (folderId) =>
            inSelection ? moveSelectedMessagesToFolder(folderId) : moveToFolder(message.id, folderId),
          copy: (folderId) => copyToFolder(message.id, folderId),
          print: () => printMessageById(message.id),
          flagTask: () => flagMessageAsTask(message.id)
        },
        run
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, message, inSelection, selectionCount]
  )

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
