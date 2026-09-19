import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

export type SelectOption = {
  value: string
  label: string
  /** What the trigger shows for this option; defaults to the label. */
  display?: ReactNode
  /** Extra class for this option's row in the list, e.g. a method colour. */
  className?: string
}

type Props = {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  className?: string
  'aria-label'?: string
}

/** Gap between the trigger and its list. */
const GAP = 4
/** Room the list keeps from the window edge. */
const EDGE = 8
/** Tallest the list gets before it scrolls. */
const MAX_HEIGHT = 280
/** Room below the trigger that counts as "enough"; less than this flips the
 *  list above it, provided there is more room up there. */
const FLIP_ROOM = 120

/** Where the open list sits, in viewport coordinates. */
type PopPos = {
  left: number
  width: number
  maxHeight: number
  /** Anchored by its top edge, or by its bottom edge when it flips above. */
  top: number | null
  bottom: number | null
}

/**
 * A dropdown in DBX's own shape: a trigger row that shows the current value
 * with a caret, and a floating list where the chosen item is ticked and the
 * item under the pointer is highlighted.
 *
 * A native <select> cannot look like that — its popup belongs to the platform,
 * not to the page. DBX's plugin host documents dbx-* component classes for
 * controls like this one, but the classes are not in the shipping host: a
 * select carrying dbx-select stays a stock platform control. So the markup is
 * ours, and the colours come from the host's tokens.
 *
 * The list is anchored to the viewport rather than to the trigger's box. The
 * request pane is a scroll container, and a list laid out inside it is both
 * clipped by it and counted into its scrollable height: opening the method
 * picker would grow the pane's scroll range by the list's own height, and the
 * rows past the pane's edge would be unreachable. Fixed placement escapes the
 * clip and leaves the scroll range alone, and it is recomputed while the list
 * is open so it follows its trigger.
 */
export function Select({ value, options, onChange, className, ...rest }: Props) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<PopPos | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value)

  const place = useCallback(() => {
    const el = trigger.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const below = window.innerHeight - rect.bottom - GAP - EDGE
    const above = rect.top - GAP - EDGE
    // Flip above only when the list cannot fit below and has more room up
    // there; anchoring the bottom edge means the list's height need not be
    // known, so placement never depends on its own measurement.
    const flip = below < FLIP_ROOM && above > below
    const space = flip ? above : below
    setPos({
      left: rect.left,
      width: rect.width,
      maxHeight: Math.max(80, Math.min(MAX_HEIGHT, space)),
      top: flip ? null : rect.bottom + GAP,
      bottom: flip ? window.innerHeight - rect.top + GAP : null,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false)
        return
      }
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', close)
    document.addEventListener('pointerdown', close)
    // The trigger can move under the list — a pane scrolling, the window
    // resizing — so the list re-anchors rather than drifting off it.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  const label = rest['aria-label']
  return (
    <div className={className ? `pick ${className}` : 'pick'} ref={root}>
      <button
        type="button"
        className="pick-trigger"
        ref={trigger}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          // Placed before the list renders, so it never paints at a stale spot.
          place()
          setOpen(true)
        }}
      >
        <span className="pick-value">{selected?.display ?? selected?.label ?? ''}</span>
        <Icon name="chevron-down" size={13} className="pick-caret" />
      </button>
      {open && pos && (
        <div
          className="pick-pop"
          role="listbox"
          aria-label={label}
          style={{
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            top: pos.top ?? 'auto',
            bottom: pos.bottom ?? 'auto',
          }}
        >
          {options.map(option => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={
                option.value === value
                  ? `pick-opt active${option.className ? ` ${option.className}` : ''}`
                  : option.className
                    ? `pick-opt ${option.className}`
                    : 'pick-opt'
              }
              onClick={() => {
                onChange(option.value)
                setOpen(false)
              }}
            >
              <span>{option.label}</span>
              {option.value === value && <Icon name="check" size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
