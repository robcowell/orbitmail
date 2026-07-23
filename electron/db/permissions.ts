import { chmodSync, existsSync, mkdirSync, statSync } from 'fs'

// Every local copy of the user's mail is readable by anyone with an account on
// the machine unless we say otherwise. Electron creates `~/.config/orbit-mail`
// as 0700, but everything we make inside it followed the process umask: the
// database landed 0644 and the data directories 0775, so on a shared machine
// another user could read the message bodies, the attachment files, and the
// encrypted credential blobs.
//
// The modes are enforced on every start rather than only at creation, so an
// existing install is corrected in place — a fix that only applied to fresh
// databases would never reach the people who already have one.

/** Directories we create: owner-only, like the userData root above them. */
export const PRIVATE_DIR_MODE = 0o700

/** Files we create: owner read/write, nobody else. */
export const PRIVATE_FILE_MODE = 0o600

export function ensurePrivateDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE })
    return dir
  }
  restrict(dir, PRIVATE_DIR_MODE)
  return dir
}

/**
 * Tighten a path's permissions if they are looser than they should be.
 *
 * Never widens: a user who has deliberately restricted something further keeps
 * their choice. Failures are swallowed — on a filesystem that cannot express
 * these modes the app must still run, and refusing to start over a chmod would
 * be a worse outcome than the exposure it prevents.
 */
export function restrict(path: string, mode: number): void {
  try {
    if (!existsSync(path)) return
    const current = statSync(path).mode & 0o777
    if ((current & ~mode) === 0) return // already at least this tight
    chmodSync(path, current & mode)
  } catch {
    // Best effort by design; see above.
  }
}

/**
 * SQLite writes two sidecar files next to the database in WAL mode, and they
 * hold the same content as the database itself — a `-wal` full of message
 * bodies is no less sensitive than the `.db`. They are created by SQLite, not
 * by us, so they need restricting after the connection opens.
 */
export function restrictDatabaseFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    restrict(path, PRIVATE_FILE_MODE)
  }
}
