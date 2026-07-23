import { resolve } from 'path'

// Paths the user has actually chosen to attach to a message.
//
// `compose:send` used to hand whatever `attachmentPaths` the renderer supplied
// straight to `readFileSync`. The renderer is the process that renders
// untrusted email HTML, so anything that ever gained script execution there
// could attach `~/.ssh/id_rsa`, `~/.config/orbit-mail/data/orbit-mail.db` or any
// other readable file and mail it out — a file-exfiltration primitive reachable
// from a message. The sanitizer, CSP and context isolation are what stop that
// script execution; this is the layer that limits the damage if they fail.
//
// Only three moments approve a path, and none of them lets the renderer name a
// file of its own choosing:
//
//   1. the OS file dialog (`compose:pickAttachments`) — main sees the result;
//   2. a real drag-and-drop, resolved by `webUtils.getPathForFile` in the
//      preload, which yields nothing for a `File` the renderer constructs;
//   3. a path main itself created — the raw `.eml` written for
//      forward-as-attachment.
//
// Anything else is refused, including paths the renderer passes to
// `compose.open`, which it can call freely.

const approved = new Set<string>()

/** Normalizing means `/tmp/./x` and `/tmp/x` cannot disagree about approval. */
function normalize(path: string): string {
  return resolve(path)
}

export function approveAttachmentPath(path: string): string {
  const normalized = normalize(path)
  approved.add(normalized)
  return normalized
}

export function isAttachmentApproved(path: string): boolean {
  return approved.has(normalize(path))
}

/** Approval lasts for the compose session that earned it. */
export function clearApprovedAttachments(): void {
  approved.clear()
}

/**
 * Throws unless every path was approved. Callers get the offending path in the
 * message: a legitimate attachment is always approved, so this firing means
 * either a bug or an attempt to read a file the user never chose.
 */
export function assertAttachmentsApproved(paths: readonly string[] | undefined): void {
  if (!paths?.length) return
  const rejected = paths.filter((path) => !isAttachmentApproved(path))
  if (rejected.length === 0) return
  throw new Error(
    `Refusing to attach ${rejected.length === 1 ? 'a file' : 'files'} that was not chosen ` +
      `in this compose window: ${rejected.join(', ')}`
  )
}

/** Test seam — the approved set is process-wide state. */
export function approvedAttachmentCount(): number {
  return approved.size
}
