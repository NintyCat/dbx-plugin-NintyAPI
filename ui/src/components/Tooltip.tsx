import { useEffect, useState } from 'react'

/** How long the cursor has to rest before a tooltip shows. */
const SHOW_DELAY = 120
const GAP = 6
const EDGE = 8
/** Room a tooltip needs below the element before it flips above it. */
const FLIP_ROOM = 44

export type TooltipState = {
  text: string
  x: number
  y: number
  above: boolean
} | null

/**
 * Fast stand-in for the browser's `title` tooltip, which takes about a second
 * to appear and cannot be styled. Hovering any element that carries a title
 * shows ours after SHOW_DELAY; the title is taken off the element meanwhile so
 * the native one does not show up as well, and put back as soon as we hide.
 */
export function useTooltips(): TooltipState {
  const [shown, setShown] = useState<TooltipState>(null)

  useEffect(() => {
    let target: HTMLElement | null = null
    let stashed: string | null = null
    let timer = 0

    const hide = () => {
      window.clearTimeout(timer)
      if (target && stashed !== null) target.setAttribute('title', stashed)
      target = null
      stashed = null
      setShown(null)
    }

    const onOver = (event: PointerEvent) => {
      const element = (event.target as Element | null)?.closest?.('[title]')
      if (!(element instanceof HTMLElement) || element === target) return
      hide()
      if (!element.getAttribute('title')) return
      target = element
      timer = window.setTimeout(() => {
        if (!target) return
        // The pointer is on the element, so it is visible by definition.
        const rect = target.getBoundingClientRect()
        stashed = target.getAttribute('title')
        target.removeAttribute('title')
        const above = rect.bottom + FLIP_ROOM > window.innerHeight
        setShown({
          text: stashed ?? '',
          x: Math.min(Math.max(rect.left + rect.width / 2, EDGE), window.innerWidth - EDGE),
          y: above ? rect.top - GAP : rect.bottom + GAP,
          above,
        })
      }, SHOW_DELAY)
    }

    // Children count as the same target: moving inside a button must not blink.
    const onOut = (event: PointerEvent) => {
      if (!target) return
      const next = event.relatedTarget
      if (next instanceof Node && target.contains(next)) return
      hide()
    }

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', hide, true)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    window.addEventListener('resize', hide)
    return () => {
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', hide, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
      window.removeEventListener('resize', hide)
      hide()
    }
  }, [])

  return shown
}

/** Draws whatever useTooltips() currently has to show. */
export function TooltipLayer({ tooltip }: { tooltip: TooltipState }) {
  if (!tooltip) return null
  return (
    <div
      className={tooltip.above ? 'tooltip above' : 'tooltip'}
      role="tooltip"
      style={{ left: tooltip.x, top: tooltip.y }}
    >
      {tooltip.text}
    </div>
  )
}
