#!/usr/bin/env node
// Mutation check for the pure renderer logic — the only suite fast enough to
// run hundreds of times.
//
//   npm run test:mutants              # every covered module
//   npm run test:mutants -- --file src/utils/search.ts
//   npm run test:mutants -- --strict  # exit 1 on an unjustified survivor
//
// WHY THIS EXISTS
//
// A passing test says the code did something. It does not say the test would
// have noticed had the code done something else. Those are different claims,
// and several assertions in this repo have made the first while failing the
// second — asserting a proxy (`scrollWidth > clientWidth` for "scrollable", a
// formatted string for "the right value") that holds whether or not the
// property does. Each was found by hand, one at a time, by breaking the code
// on a hunch. This does it systematically instead.
//
// HOW IT WORKS
//
// One token is changed at a time (`>` to `>=`, `&&` to `||`, `Math.max` to
// `Math.min`), then `npm run test:store` runs. A mutant that is **caught** made
// some assertion fail — good. A mutant that **survives** means nothing in the
// suite depends on that decision: the code could be wrong there and no test
// would say so.
//
// TYPE-ONLY EDITS ARE NOT MUTATIONS. `Pick<Account, 'id'>[]` contains a `>`
// that a regex will happily change, and the result compiles to identical
// JavaScript. Every candidate is bundled with esbuild first and skipped when
// the output is byte-identical to the baseline — which also discards edits that
// land inside comments and strings that do not affect behaviour.
//
// EQUIVALENT MUTANTS ARE REAL. Some survivors cannot be caught by any test,
// because the change makes no observable difference: a `>=` that only differs
// at an exact boundary where both branches produce the same answer. Those go in
// `mutants.allow.json` **with a reason**. Writing the reason is the point — it
// forces the question "is this genuinely unobservable, or have I just not
// thought of the case?" more than once, which is how two real gaps in
// syncStatus.ts were found.
//
// A SCORE IS NOT A GRADE. Mutation scores invite gaming: they rise just as
// easily by asserting more things as by asserting better ones. This is a smoke
// detector. It runs on demand, not in CI, because a slow check that fails for
// defensible reasons is a check people learn to skip.
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { join, dirname, relative } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'esbuild'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOW_PATH = join(ROOT, 'scripts', 'mutants.allow.json')

// The pure modules `test:store` reaches. Deliberately not mailStore.ts: it is
// large, mostly IPC orchestration, and a mutation run over it would take an
// hour to tell us what its own targeted tests already do.
// Renderer modules run against `test:store`; main-process ones against
// `test:pure`. Both suites are ~1s, which is what makes this feasible at all.
const SUITE_FOR = (file) =>
  file.startsWith('electron/') ? 'npm run test:pure' : 'npm run test:store'

const DEFAULT_TARGETS = [
  'electron/services/network-reachability.ts',
  'electron/services/attachment-safety.ts',
  'electron/services/sync-policy.ts',
  'electron/services/thread-util.ts',
  'src/utils/paneLayout.ts',
  'src/utils/syncStatus.ts',
  'src/utils/search.ts',
  'src/utils/listHeader.ts',
  'src/utils/snoozePresets.ts',
  'src/utils/folders.ts',
  'src/utils/emailColorScheme.ts'
]

// Kept small and high-signal. Each one corresponds to a mistake that actually
// gets made: an off-by-one boundary, an inverted condition, a swapped bound.
const RULES = [
  { id: 'gte->gt', find: />=/g, replace: '>' },
  { id: 'lte->lt', find: /<=/g, replace: '<' },
  { id: 'eq->neq', find: / === /g, replace: ' !== ' },
  { id: 'neq->eq', find: / !== /g, replace: ' === ' },
  { id: 'and->or', find: / && /g, replace: ' || ' },
  { id: 'or->and', find: / \|\| /g, replace: ' && ' },
  { id: 'true->false', find: /\breturn true\b/g, replace: 'return false' },
  { id: 'false->true', find: /\breturn false\b/g, replace: 'return true' },
  { id: 'max->min', find: /\bMath\.max\(/g, replace: 'Math.min(' },
  { id: 'min->max', find: /\bMath\.min\(/g, replace: 'Math.max(' }
]

const args = process.argv.slice(2)
const strict = args.includes('--strict')
const fileArg = args.indexOf('--file')
const targets =
  fileArg >= 0 && args[fileArg + 1] ? [args[fileArg + 1]] : DEFAULT_TARGETS

const allow = existsSync(ALLOW_PATH)
  ? JSON.parse(readFileSync(ALLOW_PATH, 'utf8'))
  : { equivalent: [] }

/** Line numbers move; the line's text and the rule identify a site stably. */
const allowKey = (entry) => `${entry.file}|${entry.rule}|${entry.code}`
const allowed = new Map(allow.equivalent.map((e) => [allowKey(e), e.reason]))

async function bundleOf(file) {
  const result = await build({
    entryPoints: [join(ROOT, file)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent'
  })
  return result.outputFiles[0].text
}

function runSuite(file) {
  try {
    execSync(SUITE_FOR(file), { cwd: ROOT, stdio: 'pipe', timeout: 180_000 })
    return true // suite passed — the mutant survived
  } catch {
    return false // suite failed — the mutant was caught
  }
}

/** Every single-site application of every rule, as candidate mutated sources. */
function* candidates(source) {
  for (const rule of RULES) {
    const matches = [...source.matchAll(rule.find)]
    for (let i = 0; i < matches.length; i++) {
      let seen = -1
      const mutated = source.replace(rule.find, (match) => {
        seen++
        return seen === i ? rule.replace : match
      })
      if (mutated === source) continue
      const index = matches[i].index
      const line = source.slice(0, index).split('\n').length
      const code = source.split('\n')[line - 1].trim()
      yield { rule: rule.id, line, code, mutated }
    }
  }
}

async function main() {
  const survivors = []
  const justified = []
  let applied = 0
  let caught = 0
  let skipped = 0

  for (const file of targets) {
    const abs = join(ROOT, file)
    if (!existsSync(abs)) {
      console.error(`  ! ${file} does not exist`)
      process.exitCode = 1
      return
    }
    const original = readFileSync(abs, 'utf8')
    const baseline = await bundleOf(file)
    process.stdout.write(`\n${file}\n`)

    try {
      for (const candidate of candidates(original)) {
        writeFileSync(abs, candidate.mutated)

        // A change that compiles to identical JavaScript is not a mutation —
        // it landed in a type annotation, a comment, or dead syntax.
        const mutantBundle = await bundleOf(file)
        if (mutantBundle === baseline) {
          skipped++
          continue
        }

        applied++
        const survived = runSuite(file)
        if (!survived) {
          caught++
          continue
        }

        const key = allowKey({ file, rule: candidate.rule, code: candidate.code })
        const reason = allowed.get(key)
        if (reason) {
          justified.push({ file, ...candidate, reason })
        } else {
          survivors.push({ file, ...candidate })
          process.stdout.write(
            `  SURVIVED  line ${candidate.line}  [${candidate.rule}]  ${candidate.code}\n`
          )
        }
      }
    } finally {
      // Always, even on a throw or a Ctrl-C mid-run: leaving a mutated source
      // behind would be far worse than any bug this finds.
      writeFileSync(abs, original)
    }
  }

  console.log('\n=== mutation check ===')
  console.log(`mutants applied        : ${applied}`)
  console.log(`caught by the suite    : ${caught}`)
  console.log(`survived, justified    : ${justified.length}`)
  console.log(`survived, UNJUSTIFIED  : ${survivors.length}`)
  console.log(`skipped (no-op edits)  : ${skipped}`)

  if (survivors.length > 0) {
    console.log(
      '\nEach of these is a decision no assertion depends on. Either write a test\n' +
      'that fails when it changes, or record it in scripts/mutants.allow.json with\n' +
      'a reason it cannot be observed. Copy the entries below to start:\n'
    )
    console.log(
      JSON.stringify(
        survivors.map((s) => ({
          file: s.file,
          rule: s.rule,
          code: s.code,
          reason: 'TODO: why can no test observe this?'
        })),
        null,
        2
      )
    )
  }

  if (strict && survivors.length > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('mutation check failed:', err)
  process.exitCode = 1
})
