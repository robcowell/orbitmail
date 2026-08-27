/**
 * When "later" actually means.
 *
 * Pure and given an explicit `now`, so the arithmetic can be tested without
 * waiting for Tuesday. Every preset lands on a **whole hour** rather than
 * now-plus-an-offset: a message snoozed at 09:47 until tomorrow should arrive
 * at 08:00, not 09:47, or the inbox fills with mail at times nobody chose.
 */

export type SnoozePresetId =
  | 'later-today'
  | 'tomorrow'
  | 'this-weekend'
  | 'next-week'

export interface SnoozePreset {
  id: SnoozePresetId
  label: string
  /** Null when the preset has already passed today — see `snoozePresets`. */
  wakeAt: number | null
}

/** The hour the working day starts, for every preset that means "a morning". */
const MORNING_HOUR = 8
/** "Later today" is the afternoon, unless the afternoon has been and gone. */
const AFTERNOON_HOUR = 14
const EVENING_HOUR = 18

function at(from: Date, dayOffset: number, hour: number): number {
  const d = new Date(from)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

/** Days until the next Saturday. Today counts as 7 — "this weekend" on a
 *  Saturday means next Saturday, not five minutes ago. */
function daysUntilSaturday(day: number): number {
  const delta = (6 - day + 7) % 7
  return delta === 0 ? 7 : delta
}

/** Days until the next Monday, with the same rule. */
function daysUntilMonday(day: number): number {
  const delta = (1 - day + 7) % 7
  return delta === 0 ? 7 : delta
}

export function snoozePresets(now: number): SnoozePreset[] {
  const from = new Date(now)
  const hour = from.getHours()
  const day = from.getDay()

  // "Later today" only exists while there is a later today worth having: the
  // afternoon if it has not started, the evening if it has. Past the evening it
  // is offered as null and the caller hides it, rather than silently meaning
  // tomorrow — a preset that lies about when it will fire is worse than one
  // that is missing.
  const laterToday =
    hour < AFTERNOON_HOUR
      ? at(from, 0, AFTERNOON_HOUR)
      : hour < EVENING_HOUR
        ? at(from, 0, EVENING_HOUR)
        : null

  return [
    { id: 'later-today', label: 'Later today', wakeAt: laterToday },
    { id: 'tomorrow', label: 'Tomorrow', wakeAt: at(from, 1, MORNING_HOUR) },
    {
      id: 'this-weekend',
      label: 'This weekend',
      wakeAt: at(from, daysUntilSaturday(day), MORNING_HOUR)
    },
    {
      id: 'next-week',
      label: 'Next week',
      wakeAt: at(from, daysUntilMonday(day), MORNING_HOUR)
    }
  ]
}

/** How a snoozed-until time reads in a menu or a row. */
export function formatWakeAt(wakeAt: number, now = Date.now()): string {
  const wake = new Date(wakeAt)
  const today = new Date(now)
  const sameDay =
    wake.getFullYear() === today.getFullYear() &&
    wake.getMonth() === today.getMonth() &&
    wake.getDate() === today.getDate()

  const time = wake.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const isTomorrow =
    wake.getFullYear() === tomorrow.getFullYear() &&
    wake.getMonth() === tomorrow.getMonth() &&
    wake.getDate() === tomorrow.getDate()
  if (isTomorrow) return `tomorrow at ${time}`

  // Within the week, a weekday name is easier to place than a date.
  if (wakeAt - now < 6 * 24 * 3600 * 1000) {
    return `${wake.toLocaleDateString(undefined, { weekday: 'long' })} at ${time}`
  }
  return `${wake.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`
}
