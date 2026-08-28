#!/usr/bin/env node
// The database layer, under plain node.
//
//   npm run test:db     # ~1s, no Docker, no Electron
//
// WHY THIS EXISTS
//
// `better-sqlite3` is a native module built against Electron's ABI, so until now
// nothing that touched the database could be loaded by `node`. Every DB check
// lived in `test:imap`: Docker for GreenMail, a windowless Electron process for
// the driver, ~90s a run. That was fine as a gate and useless as a measurement —
// a mutation sweep over `db-service.ts` against a 90-second suite is a sweep
// nobody runs, which is why the database was the largest body of logic in this
// repo with no mutation coverage at all.
//
// Node ships SQLite in its standard library now. `scripts/sqlite-node-shim.mjs`
// adapts that binding to the shape `better-sqlite3` presents, and esbuild swaps
// one for the other at bundle time along with the two pieces of `electron` the
// DB layer reaches for. The code under test is the code that ships — the real
// `db-service.ts`, the real schema, the real migrations — not a copy of it.
//
// WHAT KEEPS IT HONEST
//
// The assertions are not here. They are in `scripts/db-contract.suite.ts`, and
// `test:imap` runs that same file against real `better-sqlite3` inside Electron.
// A behaviour the shim gets wrong fails there. This runner is the fast lane, not
// a replacement for the slow one — if the two disagree, the slow one is right.
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(join(tmpdir(), 'orbit-db-run-'))
const require = createRequire(import.meta.url)

let failures = 0
const ok = (name, cond, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (name) => console.log(`\n${name}`)

async function main() {
  const outfile = join(outDir, 'db-contract.cjs')
  // One entry point, so there is one module graph and therefore one database
  // connection. Bundling db-service and preferences-service separately would
  // give each its own copy of `electron/db`, its own singleton, and its own
  // caches — two connections quietly disagreeing about the same file.
  await build({
    entryPoints: [join(root, 'scripts/db-contract.suite.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile,
    alias: {
      'better-sqlite3': join(root, 'scripts/sqlite-node-shim.mjs'),
      electron: join(root, 'scripts/electron-stub.mjs')
    },
    logLevel: 'silent'
  })

  require(outfile).runDbContract(ok, section)

  console.log(
    `\n${failures === 0 ? 'all db checks passed' : `${failures} db check(s) FAILED`}`
  )
  return failures === 0 ? 0 : 1
}

main()
  .then((code) => {
    rmSync(outDir, { recursive: true, force: true })
    process.exit(code)
  })
  .catch((err) => {
    console.error(err)
    rmSync(outDir, { recursive: true, force: true })
    process.exit(1)
  })
