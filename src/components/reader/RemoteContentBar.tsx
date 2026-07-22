import { useState } from 'react'
import { Image } from '@phosphor-icons/react/dist/ssr/Image'
import { useMailStore, allowSenderImages } from '../../stores/mailStore'
import { hasRemoteContent } from '../../utils/sanitizeEmailHtml'
import { extractSenderEmail } from '../../utils/messageActions'

// Shown above a message body when its remote images were blocked. Loading them
// fires whatever tracking they carry and reveals the reader's IP to the sender,
// so it is an explicit choice: once for this message, or always for this sender.
export function RemoteContentBar({
  sender,
  onLoadOnce,
  onAlwaysAllow
}: {
  sender: string
  onLoadOnce: () => void
  onAlwaysAllow: () => void
}) {
  return (
    <div className="remote-content-bar" role="status">
      <Image size={15} weight="duotone" />
      <span>Remote images were blocked to protect your privacy.</span>
      <button type="button" className="remote-content-load" onClick={onLoadOnce}>
        Load images
      </button>
      {sender && (
        <button type="button" className="remote-content-allow" onClick={onAlwaysAllow}>
          Always load from {sender}
        </button>
      )}
    </div>
  )
}

// Blocking state for one message's remote images. `blocked` drives both the
// sanitize option and whether the bar shows. Blocking lifts when the sender is
// on the allowlist, or the user loaded this message once this session.
export function useRemoteImageBlocking(
  messageId: string,
  from: string,
  bodyHtml: string | null | undefined
): { blocked: boolean; senderEmail: string; loadOnce: () => void; alwaysAllow: () => void } {
  const allowed = useMailStore((s) => s.imageAllowedSenders)
  const [loadedIds, setLoadedIds] = useState<ReadonlySet<string>>(() => new Set())
  const senderEmail = extractSenderEmail(from).toLowerCase()
  const blocked =
    !allowed.includes(senderEmail) && !loadedIds.has(messageId) && hasRemoteContent(bodyHtml)
  return {
    blocked,
    senderEmail,
    loadOnce: () => setLoadedIds((prev) => new Set(prev).add(messageId)),
    alwaysAllow: () => void allowSenderImages(senderEmail)
  }
}
