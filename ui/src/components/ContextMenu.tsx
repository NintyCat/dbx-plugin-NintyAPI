import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'

export type ContextMenuItem = {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  /** Draw a divider above this item, grouping it away from the ones before. */
  divider?: boolean
  onSelect: () => void
}

/**
 * Cursor-anchored action menu for right-click. Fixed positioning lets it
 * escape the tree's scroll container; it re-anchors itself inside the
 * viewport on layout changes and closes on outside click, Esc, or scroll.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number
  y: number
  items: ContextMenuItem[]
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  const anchor = useRef({ x, y })
  anchor.current = { x, y }

  const place = useCallback(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let left = anchor.current.x
    let top = anchor.current.y
    if (left + rect.width > window.innerWidth - 8)
      left = Math.max(8, window.innerWidth - 8 - rect.width)
    if (top + rect.height > window.innerHeight - 8)
      top = Math.max(8, window.innerHeight - 8 - rect.height)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [])

  useLayoutEffect(() => {
    place()
  }, [x, y, place])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // Any scroll moves content out from under the cursor; resize just needs
    // the menu re-anchored so it stays on screen.
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', place)
    }
  }, [onClose, place])

  return (
    <div className="menu ctx-menu" role="menu" ref={ref} style={{ left: x, top: y }}>
      {items.map(item => (
        <Fragment key={item.label}>
          {item.divider && <div className="menu-sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            className={item.danger ? 'menu-item danger' : 'menu-item'}
            disabled={item.disabled}
            aria-disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              item.onSelect()
              onClose()
            }}
          >
            {item.icon}
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}
