/**
 * How a Ctrl+U exchange of the two panes is shown: the card shuffle.
 *
 * The exchange itself is a rebinding, not a redraw — each controller keeps its
 * directory, cursor, marks and filter, and the two simply trade columns in a
 * single frame (see `swapPanels` in useWorkspace.ts) — so the panes do not move
 * and there is nothing in them to animate in place. The motion has to come from
 * copies: each pane is cloned into a layer over the row, the two copies travel
 * to the opposite column and fade as they go, and the real panes cross-fade
 * underneath them, which is what makes two folders read as having changed
 * places rather than blinked.
 *
 * It is also why this has to be careful about what it copies. A pane whose
 * footer is playing a clip would hand its player to the copy, and a second
 * element on the same ranged stream is a second decode of the same frames for a
 * picture that is on screen for a quarter of a second — so the copies carry no
 * player.
 */

/** Long enough to read as travel, short enough not to be in the way. */
const SHUFFLE_MS = 260

export interface SwapScene {
  /**
   * The flex row the two panes sit in. It is the positioning context the layers
   * are appended to, and what the copies travel across.
   */
  host: HTMLElement
  /** The pane in the left column, and the pane in the right one. */
  left: HTMLElement
  right: HTMLElement
  /**
   * Exchange the two controllers. It is called once the copies are taken, since
   * they are the old arrangement and the panes are the new one — and because a
   * clone taken after the exchange would show the two folders already swapped.
   */
  apply: () => void
}

function animate(element: Element, frames: Keyframe[], duration: number): Animation {
  return element.animate(frames, { duration, easing: 'ease-out', fill: 'none' })
}

/** Show a Ctrl+U exchange as two panes changing places. */
export function playSwapAnimation({ host, left, right, apply }: SwapScene): void {
  const scene = host.getBoundingClientRect()

  const traveling = [
    { pane: left, dx: right.getBoundingClientRect().left - left.getBoundingClientRect().left },
    { pane: right, dx: left.getBoundingClientRect().left - right.getBoundingClientRect().left }
  ]

  const ghosts = traveling.map(({ pane, dx }) => {
    const box = pane.getBoundingClientRect()

    const layer = document.createElement('div')
    layer.className = 'swap-layer swap-ghost'
    // A picture of a pane is not a second pane: the copy is inert on the pointer
    // through the class, and this keeps it out of the accessibility tree too.
    layer.setAttribute('aria-hidden', 'true')
    layer.style.left = `${box.left - scene.left}px`
    layer.style.top = `${box.top - scene.top}px`
    layer.style.width = `${box.width}px`
    layer.style.height = `${box.height}px`

    const copy = pane.cloneNode(true) as HTMLElement
    for (const player of copy.querySelectorAll('video')) player.remove()
    // The copy is a flex column whose own height comes from its contents, so it
    // has to be told to fill the box the layer gives it, or the listing inside
    // would stop at its last row and never match the pane it stands in for.
    copy.style.width = '100%'
    copy.style.height = '100%'
    layer.appendChild(copy)
    host.appendChild(layer)

    return { layer, dx }
  })

  apply()

  for (const pane of [left, right]) {
    animate(pane, [{ opacity: 0.55 }, { opacity: 1 }], SHUFFLE_MS)
  }

  for (const { layer, dx } of ghosts) {
    const flight = animate(
      layer,
      [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: `translateX(${dx}px)`, opacity: 0.05 }
      ],
      SHUFFLE_MS
    )
    flight.finished.finally(() => layer.remove()).catch(() => {})
  }
}
