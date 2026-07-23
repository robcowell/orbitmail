import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { PRIVATE_DIR_MODE } from '../db/permissions'

// Forward-as-attachment downloads the original message and writes it to disk so
// it can be attached. That file is a whole email — headers, body, attachments —
// and it used to be written straight into /tmp at the process umask (0644 on a
// typical desktop) under a predictable name, and never deleted. On a shared
// machine every message anyone ever forwarded stayed world-readable in /tmp
// until a reboot.
//
// Exports now live in one owner-only directory per run, removed when the app
// quits. A crash leaves the directory behind, so a run also clears out any left
// by earlier ones.

const PREFIX = 'orbit-mail-export-'

/** Directories older than this are from a run that is long gone. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000

let sessionDir: string | null = null

/** The current run's export directory, created owner-only on first use. */
export function getExportDir(): string {
  if (!sessionDir) {
    sessionDir = mkdtempSync(join(tmpdir(), PREFIX))
    // mkdtemp is 0700 already; being explicit keeps it true if that changes.
    try {
      chmodSync(sessionDir, PRIVATE_DIR_MODE)
    } catch {
      // Best effort — an unusual filesystem should not stop a forward.
    }
  }
  return sessionDir
}

/** Remove this run's exports. Called on quit. */
export function cleanupExportDir(): void {
  if (!sessionDir) return
  try {
    rmSync(sessionDir, { recursive: true, force: true })
  } catch {
    // Nothing useful to do at quit; the sweep below catches it next run.
  }
  sessionDir = null
}

/**
 * Remove export directories left behind by runs that crashed. Only touches our
 * own prefix, and only when a directory is old enough that no live run could
 * own it — a second copy of the app started a minute ago must keep its files.
 */
export function sweepStaleExportDirs(now = Date.now()): number {
  let removed = 0
  try {
    for (const entry of readdirSync(tmpdir())) {
      if (!entry.startsWith(PREFIX)) continue
      const path = join(tmpdir(), entry)
      if (path === sessionDir) continue
      try {
        if (now - statSync(path).mtimeMs < STALE_AFTER_MS) continue
        rmSync(path, { recursive: true, force: true })
        removed++
      } catch {
        // Another user's directory, or one being removed concurrently.
      }
    }
  } catch {
    // No /tmp listing available; nothing to sweep.
  }
  return removed
}
