import { useMemo } from 'react'
import type { ThreadSummary } from '../../../shared/types'
import { ContextMenu } from '../ui/ContextMenu'
import { useMailStore } from '../../stores/mailStore'
import {
  archiveThread,
  copyThreadToFolder,
  deleteThread,
  markThreadRead,
  markThreadUnread,
  moveThreadToFolder,
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
        excludeFolderId: selectedFolderId && selectedFolderId !== 'unified' ? selectedFolderId : undefined
      },
      {
        open: () => selectThread(accountId, threadId),
        compose,
        markRead: () => markThreadRead(accountId, threadId),
        markUnread: () => markThreadUnread(accountId, threadId),
        mute: () => window.orbitMail.preferences.muteSender(extractSenderEmail(thread.from)),
        block: () => window.orbitMail.preferences.blockSender(extractSenderEmail(thread.from)),
        del: () => deleteThread(accountId, threadId),
        setFlag: (color) => setThreadFlagColor(accountId, threadId, color),
        archive: () => archiveThread(accountId, threadId),
        move: (folderId) => moveThreadToFolder(accountId, threadId, folderId),
        copy: (folderId) => copyThreadToFolder(accountId, threadId, folderId),
        print: () => printThreadById(accountId, threadId)
      },
      run
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folders, selectedFolderId, thread])

  return <ContextMenu x={x} y={y} items={items} onClose={onClose} />
}
