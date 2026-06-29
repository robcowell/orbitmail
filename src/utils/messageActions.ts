import type { ComposePayload, FlagColor, Folder, MessageSummary } from '../../shared/types'
import {
  selectMessage,
  markMessageRead,
  markMessageUnread,
  moveMessageToTrash,
  moveMessageToFolder,
  copyMessageToFolder,
  archiveMessage,
  setMessageFlagColor
} from '../stores/mailStore'

export type MessageComposeMode = NonNullable<ComposePayload['mode']>

export function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+)>/)
  return (match ? match[1] : from).trim()
}

export async function openMessage(messageId: string): Promise<void> {
  await selectMessage(messageId)
}

export async function composeForMessage(
  message: MessageSummary,
  mode: MessageComposeMode
): Promise<void> {
  await window.orbitMail.compose.open({
    accountId: message.accountId,
    mode,
    originalMessageId: message.id
  })
}

export async function markRead(messageId: string): Promise<void> {
  await markMessageRead(messageId)
}

export async function markUnread(messageId: string): Promise<void> {
  await markMessageUnread(messageId)
}

export async function deleteMessage(messageId: string): Promise<void> {
  await moveMessageToTrash(messageId)
}

export async function archiveMessageById(messageId: string): Promise<void> {
  await archiveMessage(messageId)
}

export async function moveToFolder(messageId: string, folderId: string): Promise<void> {
  await moveMessageToFolder(messageId, folderId)
}

export async function copyToFolder(messageId: string, folderId: string): Promise<void> {
  await copyMessageToFolder(messageId, folderId)
}

export async function setFlag(messageId: string, flagColor: FlagColor | null): Promise<void> {
  await setMessageFlagColor(messageId, flagColor)
}

export async function muteSender(message: MessageSummary): Promise<void> {
  await window.orbitMail.preferences.muteSender(extractSenderEmail(message.from))
}

export async function blockSender(message: MessageSummary): Promise<void> {
  await window.orbitMail.preferences.blockSender(extractSenderEmail(message.from))
}

export function foldersForAccount(folders: Folder[], accountId: string): Folder[] {
  return folders
    .filter((folder) => folder.accountId === accountId)
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function folderActionItems(
  folders: Folder[],
  message: MessageSummary,
  action: 'move' | 'copy',
  onSelect: (folderId: string) => void
) {
  return foldersForAccount(folders, message.accountId)
    .filter((folder) => folder.id !== message.folderId)
    .map((folder) => ({
      id: `${action}-${folder.id}`,
      label: folder.name,
      onClick: () => onSelect(folder.id)
    }))
}
