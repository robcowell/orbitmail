// Deep per-icon imports from the standalone (ssr) build so only the icons we use
// are bundled — the barrel `@phosphor-icons/react` entry pulls the entire set.
// These variants read weight/size from props (we never use IconContext).
import type { IconProps } from '@phosphor-icons/react'
import { Tray } from '@phosphor-icons/react/dist/ssr/Tray'
import { PaperPlaneTilt } from '@phosphor-icons/react/dist/ssr/PaperPlaneTilt'
import { NotePencil } from '@phosphor-icons/react/dist/ssr/NotePencil'
import { Trash } from '@phosphor-icons/react/dist/ssr/Trash'
import { WarningCircle } from '@phosphor-icons/react/dist/ssr/WarningCircle'
import { Folder } from '@phosphor-icons/react/dist/ssr/Folder'
import { TrayArrowDown } from '@phosphor-icons/react/dist/ssr/TrayArrowDown'
import { PlusCircle } from '@phosphor-icons/react/dist/ssr/PlusCircle'
import { PencilLine } from '@phosphor-icons/react/dist/ssr/PencilLine'
import { ArrowBendUpLeft } from '@phosphor-icons/react/dist/ssr/ArrowBendUpLeft'
import { ArrowBendUpRight } from '@phosphor-icons/react/dist/ssr/ArrowBendUpRight'
import { Archive } from '@phosphor-icons/react/dist/ssr/Archive'
import { ArrowsClockwise } from '@phosphor-icons/react/dist/ssr/ArrowsClockwise'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr/MagnifyingGlass'
import { Paperclip } from '@phosphor-icons/react/dist/ssr/Paperclip'
import { EnvelopeSimpleOpen } from '@phosphor-icons/react/dist/ssr/EnvelopeSimpleOpen'
import { Planet } from '@phosphor-icons/react/dist/ssr/Planet'
import { Star } from '@phosphor-icons/react/dist/ssr/Star'
import { Envelope } from '@phosphor-icons/react/dist/ssr/Envelope'
import { X } from '@phosphor-icons/react/dist/ssr/X'
import { GearSix } from '@phosphor-icons/react/dist/ssr/GearSix'
import { CaretRight } from '@phosphor-icons/react/dist/ssr/CaretRight'
import { BellSlash } from '@phosphor-icons/react/dist/ssr/BellSlash'
import { Prohibit } from '@phosphor-icons/react/dist/ssr/Prohibit'
import { Flag } from '@phosphor-icons/react/dist/ssr/Flag'
import { Funnel } from '@phosphor-icons/react/dist/ssr/Funnel'
import { ArrowBendDoubleUpLeft } from '@phosphor-icons/react/dist/ssr/ArrowBendDoubleUpLeft'
import { ShareNetwork } from '@phosphor-icons/react/dist/ssr/ShareNetwork'
import { EnvelopeOpen } from '@phosphor-icons/react/dist/ssr/EnvelopeOpen'
import { ListChecks } from '@phosphor-icons/react/dist/ssr/ListChecks'
import { FolderPlus } from '@phosphor-icons/react/dist/ssr/FolderPlus'
import { Export } from '@phosphor-icons/react/dist/ssr/Export'
import { PencilSimple } from '@phosphor-icons/react/dist/ssr/PencilSimple'
import { Info } from '@phosphor-icons/react/dist/ssr/Info'
import { Sparkle } from '@phosphor-icons/react/dist/ssr/Sparkle'
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
  ListChecks,
  FolderPlus,
  Export,
  PencilSimple,
  Info,
  Sparkle
}

export type { IconProps }
