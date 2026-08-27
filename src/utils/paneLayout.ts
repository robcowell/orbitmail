/**
 * How the three panes share the window.
 *
 * The layout had no responsive behaviour at all — not one media query, and the
 * sidebar and list both `flex-shrink: 0`. The reader was the only flexible
 * pane, so **it absorbed every pixel the window lost**: narrow the window, or
 * snap the app to half a screen, and the reader shrank toward nothing while the
 * other two kept their full width. At around 1000px the subject line wrapped
 * across three lines with its message count stranded on a fourth.
 *
 * The rule is that the reader is what you are actually reading, so it is the
 * pane defended rather than the one sacrificed. Space is reclaimed in the order
 * a person would give it up: the list first, then the sidebar, then the sidebar
 * altogether.
 */

export const MIN_SIDEBAR_WIDTH = 180
export const MIN_LIST_WIDTH = 200
export const MIN_READER_WIDTH = 380
/** The two 1px drag handles between the panes. */
export const DIVIDER_COUNT = 2

/**
 * Below this the sidebar is not worth its 180px: the folder list is one click
 * away behind the toggle, and the reader is not.
 */
export const SIDEBAR_COLLAPSE_WIDTH = 900

export interface PaneFit {
  sidebar: number
  list: number
  reader: number
  /** True when the sidebar is not being rendered at all. */
  sidebarHidden: boolean
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function fitPanes(input: {
  containerWidth: number
  /** The widths the user dragged to, which are preferences rather than promises. */
  sidebarWidth: number
  listWidth: number
  /**
   * The user asked for the sidebar to be shown or hidden. `null` means they have
   * not expressed a preference, so the window's width decides.
   */
  sidebarPreference: boolean | null
}): PaneFit {
  const { containerWidth } = input

  // Nothing sensible to compute before the first measurement.
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
    return {
      sidebar: input.sidebarWidth,
      list: input.listWidth,
      reader: MIN_READER_WIDTH,
      sidebarHidden: false
    }
  }

  const wantsSidebar =
    input.sidebarPreference ?? containerWidth >= SIDEBAR_COLLAPSE_WIDTH

  // With the sidebar shown, can the other two still have their minimums? If not,
  // showing it would be self-defeating, so an explicit request loses to
  // arithmetic rather than producing an unusable window.
  const roomWithSidebar =
    containerWidth - DIVIDER_COUNT - MIN_SIDEBAR_WIDTH - MIN_LIST_WIDTH
  const sidebarHidden = !wantsSidebar || roomWithSidebar < MIN_READER_WIDTH

  const dividers = sidebarHidden ? 1 : DIVIDER_COUNT
  const available = containerWidth - dividers

  if (sidebarHidden) {
    // Two panes: give the list what it asked for, up to leaving the reader its
    // minimum, and never below its own.
    //
    // The final `Math.min(available, …)` is not redundant. Below MIN_LIST_WIDTH
    // of total space the lower and upper bounds both floor at MIN_LIST_WIDTH,
    // so the clamp returned a list wider than the window and the panes summed
    // to more than they had — the layout overflowed. Unreachable through the UI
    // (the window's own minWidth is 660) but wrong, and found by asserting the
    // sum invariant from 1px rather than from a comfortable width.
    const list = Math.min(
      available,
      clamp(
        input.listWidth,
        Math.min(MIN_LIST_WIDTH, available),
        Math.max(MIN_LIST_WIDTH, available - MIN_READER_WIDTH)
      )
    )
    return { sidebar: 0, list, reader: Math.max(0, available - list), sidebarHidden: true }
  }

  const sidebar = Math.max(MIN_SIDEBAR_WIDTH, input.sidebarWidth)
  const list = Math.max(MIN_LIST_WIDTH, input.listWidth)

  // Everything fits at the preferred widths.
  if (available - sidebar - list >= MIN_READER_WIDTH) {
    return { sidebar, list, reader: available - sidebar - list, sidebarHidden: false }
  }

  // It does not. Take it from the list first — the list is a column of rows and
  // degrades gracefully; the reader is prose and does not.
  const listGive = Math.min(list - MIN_LIST_WIDTH, sidebar + list + MIN_READER_WIDTH - available)
  const listAfter = list - listGive
  if (available - sidebar - listAfter >= MIN_READER_WIDTH) {
    return {
      sidebar,
      list: listAfter,
      reader: available - sidebar - listAfter,
      sidebarHidden: false
    }
  }

  // Then the sidebar, down to its own minimum.
  const sidebarGive = Math.min(
    sidebar - MIN_SIDEBAR_WIDTH,
    sidebar + listAfter + MIN_READER_WIDTH - available
  )
  const sidebarAfter = sidebar - sidebarGive

  return {
    sidebar: sidebarAfter,
    list: listAfter,
    // Whatever is left. Below every minimum combined there is nothing to
    // apportion, and clamping to MIN_READER_WIDTH here would overflow the
    // window instead — a horizontal scrollbar on the whole app is worse than a
    // narrow reader.
    reader: Math.max(0, available - sidebarAfter - listAfter),
    sidebarHidden: false
  }
}
