import { readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getAttachmentsDir, getRawSqlite } from '../db'
import { PRIVATE_FILE_MODE, restrict } from '../db/permissions'

// Attachment files have been written 0600 since #42, and the directory holding
// them is 0700 since #90 — but files downloaded before that keep the mode they
// were created with. On the profile this was checked against, 1,154 of 1,156
// files were still 0664.
//
// The 0700 directory means they are not reachable by another user *in place*, so
// this is defence in depth rather than an open hole: it matters if the directory
// mode is ever loosened again, or if the files are copied somewhere that
// preserves their permissions — a backup, an rsync to another machine.
//
// Walking a large attachment store on every launch would be waste, so this runs
// once and records that it has, in the same guarded style as the other one-time
// migrations.

const GUARD_KEY = 'attachment_perms_v1'

function alreadyRun(): boolean {
  const row = getRawSqlite()
    .prepare('SELECT value FROM app_preferences WHERE key = ?')
    .get(GUARD_KEY) as { value: string } | undefined
  return row?.value === '1'
}

function markRun(): void {
  getRawSqlite()
    .prepare(
      'INSERT INTO app_preferences (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(GUARD_KEY, '1')
}

/**
 * Tighten attachment files left world- or group-readable by older versions.
 *
 * Only ever clears permission bits (`restrict`), so a file the user made
 * stricter stays that way. The guard is written only on a clean pass: if the
 * walk throws half way, the next launch tries again rather than recording a job
 * it did not finish.
 */
export function restrictExistingAttachments(): { scanned: number; tightened: number } {
  if (alreadyRun()) return { scanned: 0, tightened: 0 }

  const dir = getAttachmentsDir()
  let scanned = 0
  let tightened = 0

  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    let mode: number
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      mode = stats.mode & 0o777
    } catch {
      continue // vanished under us, or unreadable — neither is worth failing over
    }
    scanned++
    if ((mode & ~PRIVATE_FILE_MODE) === 0) continue
    restrict(path, PRIVATE_FILE_MODE)
    tightened++
  }

  markRun()
  return { scanned, tightened }
}
