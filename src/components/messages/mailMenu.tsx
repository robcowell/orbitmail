import type { FlagColor, Folder } from '../../../shared/types'
import { FLAG_COLORS } from '../../constants/flags'
import type { ContextMenuItem } from '../ui/ContextMenu'
import {
  extractSenderEmail,
  foldersForAccount,
  type MessageComposeMode
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
  ListChecks,
  Printer
} from '../icons'

function FlagDot({ color }: { color: string }) {
  return <span className="flag-dot" style={{ backgroundColor: color }} />
}

// Describes the row the menu acts on — a single message or a whole thread.
export interface MailMenuTarget {
  from: string
  isRead: boolean
  isStarred: boolean
  flagColor: FlagColor | null
  accountId: string
  // Current folder to omit from the "Move to" list (undefined = omit none).
  excludeFolderId?: string
}

// The action to run for each menu entry. Message- and thread-level callers wire
// these to their respective store actions.
export interface MailMenuActions {
  open: () => void | Promise<void>
  compose: (mode: MessageComposeMode) => void | Promise<void>
  markRead: () => void | Promise<void>
  markUnread: () => void | Promise<void>
  mute: () => void | Promise<void>
  block: () => void | Promise<void>
  del: () => void | Promise<void>
  setFlag: (flagColor: FlagColor | null) => void | Promise<void>
  archive: () => void | Promise<void>
  move: (folderId: string) => void | Promise<void>
  copy: (folderId: string) => void | Promise<void>
  print: () => void | Promise<void>
  // Optional — single-message menus only. Forces the email into the AI task list.
  flagTask?: () => void | Promise<void>
}

type RunFn = (action: () => void | Promise<void>, successMessage?: string) => void

function folderItems(
  folders: Folder[],
  target: MailMenuTarget,
  onSelect: (folderId: string) => void
): ContextMenuItem[] {
  return foldersForAccount(folders, target.accountId)
    .filter((folder) => folder.id !== target.excludeFolderId)
    .map((folder) => ({
      id: `folder-${folder.id}`,
      label: folder.name,
      onClick: () => onSelect(folder.id)
    }))
}

export function buildMailMenuItems(
  folders: Folder[],
  target: MailMenuTarget,
  actions: MailMenuActions,
  run: RunFn
): ContextMenuItem[] {
  const flagItems: ContextMenuItem[] = [
    ...FLAG_COLORS.map((entry) => ({
      id: `flag-${entry.id}`,
      label: entry.label,
      icon: <FlagDot color={entry.hex} />,
      onClick: () => run(() => actions.setFlag(entry.id))
    })),
    { id: 'flag-sep', label: '', separator: true, onClick: () => {} },
    {
      id: 'flag-clear',
      label: 'Clear Flag',
      disabled: !target.flagColor && !target.isStarred,
      icon: <Flag size={16} weight="duotone" />,
      onClick: () => run(() => actions.setFlag(null))
    }
  ]

  const moveItems = folderItems(folders, target, (folderId) => run(() => actions.move(folderId)))
  const copyItems = folderItems(folders, target, (folderId) => run(() => actions.copy(folderId)))

  return [
    {
      id: 'open',
      label: 'Open',
      icon: <EnvelopeSimpleOpen size={16} weight="duotone" />,
      onClick: () => run(actions.open)
    },
    {
      id: 'print',
      label: 'Print…',
      icon: <Printer size={16} weight="duotone" />,
      onClick: () => run(actions.print)
    },
    ...(actions.flagTask
      ? [
          {
            id: 'flag-task',
            label: 'Add to AI Tasks',
            icon: <ListChecks size={16} weight="duotone" />,
            onClick: () => run(actions.flagTask!)
          }
        ]
      : []),
    { id: 'sep-1', label: '', separator: true, onClick: () => {} },
    {
      id: 'send-again',
      label: 'Send Again',
      icon: <PaperPlaneTilt size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('send-again'))
    },
    {
      id: 'reply',
      label: 'Reply',
      icon: <ArrowBendUpLeft size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('reply'))
    },
    {
      id: 'reply-all',
      label: 'Reply All',
      icon: <ArrowBendDoubleUpLeft size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('reply-all'))
    },
    {
      id: 'forward',
      label: 'Forward',
      icon: <ArrowBendUpRight size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('forward'))
    },
    {
      id: 'forward-attachment',
      label: 'Forward as Attachment',
      icon: <Paperclip size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('forward-attachment'))
    },
    {
      id: 'redirect',
      label: 'Redirect',
      icon: <ShareNetwork size={16} weight="duotone" />,
      onClick: () => run(() => actions.compose('redirect'))
    },
    { id: 'sep-2', label: '', separator: true, onClick: () => {} },
    {
      id: 'mark-read',
      label: 'Mark as Read',
      disabled: target.isRead,
      icon: <EnvelopeOpen size={16} weight="duotone" />,
      onClick: () => run(actions.markRead)
    },
    {
      id: 'mark-unread',
      label: 'Mark as Unread',
      disabled: !target.isRead,
      icon: <Envelope size={16} weight="duotone" />,
      onClick: () => run(actions.markUnread)
    },
    { id: 'sep-3', label: '', separator: true, onClick: () => {} },
    {
      id: 'mute',
      label: 'Mute',
      icon: <BellSlash size={16} weight="duotone" />,
      onClick: () => run(actions.mute, `Muted ${extractSenderEmail(target.from)}`)
    },
    {
      id: 'delete',
      label: 'Delete',
      icon: <Trash size={16} weight="duotone" />,
      onClick: () => run(actions.del)
    },
    {
      id: 'block',
      label: 'Block Sender',
      icon: <Prohibit size={16} weight="duotone" />,
      onClick: () => run(actions.block, `Blocked ${extractSenderEmail(target.from)}`)
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
      onClick: () => run(actions.archive)
    },
    {
      id: 'move-to',
      label: 'Move to',
      submenu: moveItems.length
        ? moveItems
        : [{ id: 'move-empty', label: 'No folders', disabled: true, onClick: () => {} }]
    },
    {
      id: 'copy-to',
      label: 'Copy to',
      submenu: copyItems.length
        ? copyItems
        : [{ id: 'copy-empty', label: 'No folders', disabled: true, onClick: () => {} }]
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
}
