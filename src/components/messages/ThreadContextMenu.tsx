import { useMemo } from 'react'
import type { ThreadSummary } from '../../../shared/types'
import { ContextMenu } from '../ui/ContextMenu'
import { useMailStore } from '../../stores/mailStore'
import {
  archiveThread,
  archiveSelectedThreads,
  copyThreadToFolder,
  deleteThread,
  deleteSelectedThreads,
  markThreadRead,
  markThreadUnread,
  moveThreadToFolder,
  moveSelectedThreadsToFolder,
  selectThread,
  setThreadFlagColor
} from '../../stores/mailStore'
import { extractSenderEmail, type MessageComposeMode } from '../../utils/messageActions'
import { printThreadById } from '../../utils/printMessage'
import { buildMailMenuItems } from './mailMenu'

interface ThreadContextMenuProps {
  thread: ThreadSummary
  x: number
  y: number
  onClose: () => void
}

// Destructive/state actions fan out over the whole conversation; compose actions
// (reply/forward/…) act on the thread's latest message.
export function ThreadContextMenu({ thread, x, y, onClose }: ThreadContextMenuProps) {
  const folders = useMailStore((s) => s.folders)
  const selectedFolderId = useMailStore((s) => s.selectedFolderId)
  const setToast = useMailStore((s) => s.setToast)
  const selectedThreadKeys = useMailStore((s) => s.selectedThreadKeys)

  // Right-clicking inside a multi-selection acts on the whole selection;
  // right-clicking outside it acts on that row alone, as the click would.
  const inSelection =
    selectedThreadKeys.length > 1 &&
    selectedThreadKeys.includes(`${thread.accountId} ${thread.threadId}`)
  const selectionCount = inSelection ? selectedThreadKeys.length : 1

  const run = (action: () => void | Promise<void>, successMessage?: string) => {
    void Promise.resolve(action())
      .then(() => {
        if (successMessage) setToast(successMessage)
      })
      .catch((err) => {
        setToast(err instanceof Error ? err.message : 'Action failed')
      })
  }

  const items = useMemo(() => {
    const { accountId, threadId } = thread
    const compose = (mode: MessageComposeMode) =>
      window.orbitMail.compose.open({
        accountId,
        mode,
        originalMessageId: thread.latestMessageId
      })

    return buildMailMenuItems(
      folders,
      {
        from: thread.from,
        isRead: !thread.hasUnread,
        isStarred: thread.isStarred,
        flagColor: thread.flagColor,
        accountId,
        excludeFolderId: selectedFolderId && selectedFolderId !== 'unified' ? selectedFolderId : undefined,
        selectionCount
      },
      {
        open: () => selectThread(accountId, threadId),
        compose,
        markRead: () => markThreadRead(accountId, threadId),
        markUnread: () => markThreadUnread(accountId, threadId),
        mute: () => window.orbitMail.preferences.muteSender(extractSenderEmail(thread.from)),
        block: () => window.orbitMail.preferences.blockSender(extractSenderEmail(thread.from)),
        del: () => (inSelection ? deleteSelectedThreads() : deleteThread(accountId, threadId)),
        setFlag: (color) => setThreadFlagColor(accountId, threadId, color),
        archive: () => (inSelection ? archiveSelectedThreads() : archiveThread(accountId, threadId)),
        move: (folderId) =>
          inSelection
            ? moveSelectedThreadsToFolder(folderId)
            : moveThreadToFolder(accountId, threadId, folderId),
        copy: (folderId) => copyThreadToFolder(accountId, threadId, folderId),
        print: () => printThreadById(accountId, threadId)
      },
      run,
      'conversations'
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, selectedFolderId, thread])

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
