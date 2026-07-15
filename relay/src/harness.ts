// CLI harness — the vehicle for the plan's Step 5.1 proof: "sync a single Gmail
// account end-to-end before any UI work starts."
//
// It cannot run that proof in this environment: it needs Rob's OAuth *web-client*
// credentials (a new registration — see android-audit.md §7) and a live Gmail
// account, neither of which the build environment has. It is written so the proof
// can be run locally once those exist. Until the sync route is wired it exercises
// the contract (boots the server, hits /health, lists the declared routes).

import { createRelayServer } from './server.ts'
import { routes } from './routes.ts'

async function main(): Promise<void> {
  const { server, config } = createRelayServer()

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve))
  const base = `http://${config.host}:${config.port}`
  console.log(`harness: relay up at ${base}`)

  const health = await fetch(`${base}/health`).then((r) => r.json())
  console.log('harness: /health ->', health)

  console.log('harness: declared routes:')
  for (const r of routes) console.log(`  ${r.method.padEnd(4)} ${r.path}`)

  console.log(
    '\nharness: end-to-end Gmail sync is not runnable here — needs OAuth web creds + a live account.'
  )
  console.log('         wire sync.refresh, then re-run with RELAY_TEST_ACCESS_TOKEN set.')

  server.close()
}

main().catch((err) => {
  console.error('harness failed:', err)
  process.exitCode = 1
})
