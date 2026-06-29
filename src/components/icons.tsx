import type { IconProps } from '@phosphor-icons/react'
import {
  Tray,
  PaperPlaneTilt,
  NotePencil,
  Trash,
  WarningCircle,
  Folder,
  TrayArrowDown,
  PlusCircle,
  PencilLine,
  ArrowBendUpLeft,
  ArrowBendUpRight,
  Archive,
  ArrowsClockwise,
  MagnifyingGlass,
  Paperclip,
  EnvelopeSimpleOpen,
  Planet,
  Star,
  Envelope,
  X,
  GearSix,
  CaretRight,
  BellSlash,
  Prohibit,
  Flag,
  Funnel,
  ArrowBendDoubleUpLeft,
  ShareNetwork,
  EnvelopeOpen,
  ListChecks
} from '@phosphor-icons/react'
import type { FolderType } from '../../shared/types'

export const iconProps = {
  size: 18,
  weight: 'duotone' as const
}

export const sidebarIconProps = {
  size: 17,
  weight: 'duotone' as const
}

export const FOLDER_ICON_MAP: Record<FolderType, typeof Tray> = {
  inbox: Tray,
  sent: PaperPlaneTilt,
  drafts: NotePencil,
  trash: Trash,
  junk: WarningCircle,
  custom: Folder
}

export const FOLDER_COLOR_CLASS: Record<FolderType, string> = {
  inbox: 'folder-icon-inbox',
  sent: 'folder-icon-sent',
  drafts: 'folder-icon-drafts',
  trash: 'folder-icon-trash',
  junk: 'folder-icon-junk',
  custom: 'folder-icon-custom'
}

export {
  Tray,
  PaperPlaneTilt,
  NotePencil,
  Trash,
  WarningCircle,
  Folder,
  TrayArrowDown,
  PlusCircle,
  PencilLine,
  ArrowBendUpLeft,
  ArrowBendUpRight,
  Archive,
  ArrowsClockwise,
  MagnifyingGlass,
  Paperclip,
  EnvelopeSimpleOpen,
  Planet,
  Star,
  Envelope,
  X,
  GearSix,
  CaretRight,
  BellSlash,
  Prohibit,
  Flag,
  Funnel,
  ArrowBendDoubleUpLeft,
  ShareNetwork,
  EnvelopeOpen,
  ListChecks
}

export type { IconProps }
