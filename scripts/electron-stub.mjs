// The two pieces of Electron the database layer touches, and nothing else.
//
// `electron/db/index.ts` needs `app.getPath('userData')` to decide where the
// database lives; `account-credentials.ts` needs `safeStorage` to encrypt a
// token blob. Everything else in `electron` is unreachable from that import
// tree, and stubbing more would only invite a test to depend on something this
// runner cannot honestly provide.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'orbit-db-'))

export const app = {
  getPath: (name) => (name === 'userData' ? userData : join(userData, name)),
  getName: () => 'orbit-mail',
  getVersion: () => '0.0.0-test'
}

/**
 * Encryption unavailable, which is a real state and not a convenience: on a
 * machine with no keyring `safeStorage.isEncryptionAvailable()` returns false
 * and credentials fall back to plain base64. Reporting false here means the
 * suite exercises the degraded path the app genuinely has, rather than a
 * pretend-encrypted one that exists nowhere.
 */
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (buffer) => Buffer.from(buffer).toString('utf8')
}

export default { app, safeStorage }
