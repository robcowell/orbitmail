// better-sqlite3, shaped out of node:sqlite, so the database layer can run
// under plain node.
//
// WHY THIS EXISTS
//
// `better-sqlite3` is a native module built against Electron's ABI, so nothing
// that imports the database layer can be loaded by `node`. That is why the DB
// tests live in `test:imap` — Docker for GreenMail, a windowless Electron
// process for the driver, ~90s a run. A mutation sweep over `db-service.ts`
// against that suite would take days, which is why the database was the largest
// piece of this codebase with no mutation coverage at all.
//
// Node 22+ ships SQLite in the standard library. It is the same engine; only
// the binding differs. This adapts one binding to the other so the *real*
// `db-service.ts` — not a copy, not an extract — runs under `node scripts/
// db-logic.mjs` in about a second.
//
// WHAT MAKES IT HONEST
//
// A shim is a second implementation, and a second implementation is somewhere
// for a difference to hide: a suite that passes here and lies about the driver
// that actually ships would be worse than no suite. Two things stop that.
//
// 1. `scripts/db-contract.suite.ts` holds the assertions, and **both** runners
//    execute it — this shim under `test:db`, and real `better-sqlite3` inside
//    `test:imap`. A behaviour this shim gets wrong fails there.
// 2. The surface is deliberately tiny. Everything below corresponds to a call
//    that exists in `electron/`; nothing is implemented speculatively, so there
//    is less to be wrong about.
//
// The differences that had to be papered over are each commented, because the
// paperings are the part most likely to matter later.
import { DatabaseSync } from 'node:sqlite'

// node:sqlite refuses a parameter it cannot map to a SQLite type; better-sqlite3
// coerces first. Drizzle passes `undefined` for an absent column and JS booleans
// for integer flags, so without this the first real insert throws a TypeError
// about "Provided value cannot be bound" rather than doing anything useful.
const bindable = (params) =>
  params.map((v) => {
    if (v === undefined) return null
    if (typeof v === 'boolean') return v ? 1 : 0
    return v
  })

// node:sqlite hands back null-prototype objects. They behave identically for
// property access, and differently for `deepStrictEqual` and `instanceof` —
// which is exactly the sort of difference that would make an assertion fail
// here and pass in Electron, for a reason having nothing to do with the code
// under test.
const plain = (row) => (row && typeof row === 'object' && !Array.isArray(row) ? { ...row } : row)

class ShimStatement {
  constructor(statement) {
    this.statement = statement
    this.arrays = false
  }

  run(...params) {
    const result = this.statement.run(...bindable(params))
    // better-sqlite3 returns numbers here; node:sqlite may return BigInt. Callers
    // compare `changes` against numbers and one of them (`deleteMessages`)
    // returns it straight to the renderer over IPC.
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid)
    }
  }

  get(...params) {
    this.statement.setReturnArrays(this.arrays)
    return plain(this.statement.get(...bindable(params)))
  }

  all(...params) {
    this.statement.setReturnArrays(this.arrays)
    return this.statement.all(...bindable(params)).map(plain)
  }

  /** Drizzle's row-array path. Always arrays, whatever `raw()` was last set to. */
  values(...params) {
    this.statement.setReturnArrays(true)
    const rows = this.statement.all(...bindable(params))
    this.statement.setReturnArrays(this.arrays)
    return rows
  }

  raw(enabled = true) {
    this.arrays = enabled
    return this
  }

  iterate(...params) {
    this.statement.setReturnArrays(this.arrays)
    return this.statement.iterate(...bindable(params))
  }
}

export default class Database {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    // better-sqlite3 nests transactions with SAVEPOINT rather than failing.
    // `regroupThreadsForAccount` runs a transaction inside a caller that may
    // already be in one, so a shim without this would throw "cannot start a
    // transaction within a transaction" on a path that works in the app.
    this.depth = 0
  }

  prepare(sql) {
    return new ShimStatement(this.db.prepare(sql))
  }

  exec(sql) {
    this.db.exec(sql)
    return this
  }

  /**
   * better-sqlite3's `pragma()` takes the whole pragma as one string and, with
   * `{ simple: true }`, returns the first column of the first row. node:sqlite
   * has no pragma method — a PRAGMA is just a statement — so this reproduces
   * the shape rather than the call.
   */
  pragma(source, options = {}) {
    const rows = this.db.prepare(`PRAGMA ${source}`).all()
    if (options.simple) {
      const first = rows[0]
      return first ? Object.values(first)[0] : undefined
    }
    return rows.map(plain)
  }

  transaction(fn) {
    const wrapped = (...args) => {
      // SAVEPOINTs are named by depth so a nested rollback releases only its own.
      const name = `orbit_sp_${this.depth}`
      const begin = this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${name}`
      const commit = this.depth === 0 ? 'COMMIT' : `RELEASE ${name}`
      const rollback = this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${name}`
      this.db.exec(begin)
      this.depth++
      try {
        const result = fn(...args)
        this.depth--
        this.db.exec(commit)
        return result
      } catch (err) {
        this.depth--
        this.db.exec(rollback)
        if (this.depth > 0) this.db.exec(`RELEASE ${name}`)
        throw err
      }
    }
    // better-sqlite3 exposes these variants on the returned function. Nothing in
    // `electron/` calls them; they are here so that a future caller gets the
    // behaviour rather than `undefined is not a function`.
    wrapped.deferred = wrapped
    wrapped.immediate = wrapped
    wrapped.exclusive = wrapped
    return wrapped
  }

  close() {
    this.db.close()
  }
}
