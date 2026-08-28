// Window geometry decisions, separated from the store they are read out of.
//
// This is arithmetic: a remembered size and a screen in, a usable size out. It
// lived in `preferences-service.ts`, which imports the database, so testing it
// meant Docker and an Electron process — and mutation-testing it meant a sweep
// no one would ever wait for. Nothing here imports anything at runtime, so it
// runs under `npm run test:pure` and is swept by `npm run test:mutants`.
//
// What is *not* here is anything that needs a window: whether the WM honoured a
// maximize, what order a parent and child are destroyed in, whether restore-down
// lands anywhere sensible. Those are `npm run test:e2e`'s, and they stay there.
import type { ComposeWindowPreferences } from '../../shared/types'

/** What the composer opens at when nothing has been remembered yet. */
export const DEFAULT_COMPOSE_SIZE = { width: 640, height: 720 } as const
/** Matches the window's own minWidth/minHeight — see createComposeWindow. */
export const MIN_COMPOSE_SIZE = { width: 480, height: 400 } as const

/**
 * Resolve a remembered compose size against the screen it is about to open on.
 *
 * Validated here rather than trusted, because the stored value outlives the
 * display that produced it: a composer sized on a 4K monitor would otherwise
 * open larger than the laptop screen it is reopened on, with its buttons past
 * the edge and no way to reach them but a resize the user has to guess at. A
 * corrupted or hand-edited preferences blob is the same problem arriving by a
 * different route, which is why the numbers are checked for being numbers at
 * all rather than only for being large.
 */
export function resolveComposeSize(
  stored: ComposeWindowPreferences | undefined,
  workArea: { width: number; height: number }
): { width: number; height: number } {
  const usable = (value: number | undefined, fallback: number, min: number, max: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(min, Math.min(Math.round(value), Math.max(min, max)))
  }
  return {
    width: usable(stored?.width, DEFAULT_COMPOSE_SIZE.width, MIN_COMPOSE_SIZE.width, workArea.width),
    height: usable(stored?.height, DEFAULT_COMPOSE_SIZE.height, MIN_COMPOSE_SIZE.height, workArea.height)
  }
}
