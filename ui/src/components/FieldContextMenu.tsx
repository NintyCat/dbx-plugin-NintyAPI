import { useCallback, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { copyText, readText } from '../lib/clipboard'
import type { T } from '../lib/i18n'
import { ContextMenu, type ContextMenuItem } from './ContextMenu'
import { Icon } from './Icon'

type TextField = HTMLInputElement | HTMLTextAreaElement

/** Input types that expose selectionStart/End and support setRangeText. */
const SELECTABLE_TYPES = new Set(['', 'text', 'search', 'url', 'password', 'tel'])

/**
 * Input types browsers treat as a single indivisible value: they reject both
 * setSelectionRange and setRangeText, so a partial edit is impossible.
 */
const ATOMIC_TYPES = new Set(['number', 'email'])

/** The text field under the cursor, or null when the target takes no text. */
function editableAt(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target
  if (!(target instanceof HTMLInputElement)) return null
  const type = target.type.toLowerCase()
  return SELECTABLE_TYPES.has(type) || ATOMIC_TYPES.has(type) ? target : null
}

function isSelectable(field: TextField): boolean {
  return field instanceof HTMLTextAreaElement || SELECTABLE_TYPES.has(field.type.toLowerCase())
}

/**
 * The editable span of a field. Atomic fields report no selection, so their
 * whole value stands in for one: cut, copy and paste then act on the value as
 * a unit, which is the only granularity those inputs allow.
 */
function rangeOf(field: TextField): { start: number; end: number; selected: string } {
  if (!isSelectable(field)) return { start: 0, end: field.value.length, selected: field.value }
  const start = field.selectionStart ?? 0
  const end = field.selectionEnd ?? start
  return { start, end, selected: field.value.slice(start, end) }
}

/** Assign through the prototype setter so React's value tracker sees the edit. */
function setValue(field: TextField, value: string) {
  const proto = field instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(field, value)
  else field.value = value
}

/**
 * Replace the captured range with text. The offsets come from when the menu
 * opened: clicking a menu item blurs the field and collapses the live
 * selection, so re-reading it at click time would insert at the wrong place.
 */
function replaceRange(field: TextField, start: number, end: number, text: string) {
  field.focus()
  if (isSelectable(field)) {
    field.setRangeText(text, start, end, 'end')
  } else {
    setValue(field, field.value.slice(0, start) + text + field.value.slice(end))
  }
  // setRangeText and the value setter both bypass React's change detection, so
  // the controlled value would go stale without an explicit input event.
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Text fields inside the DBX workbench run in a srcdoc iframe where the host
 * suppresses the native context menu, so copy/cut/paste are unreachable
 * without one of our own. This hook supplies that menu for editable targets
 * only: right-clicking anywhere else is left alone, so the plugin never claims
 * a gesture it has nothing to offer for. Menus owned by nested surfaces (tree
 * rows, tabs) are unaffected because those targets are not text fields.
 * The clipboard itself comes from ../lib/clipboard: the same sandbox that
 * hides the menu also denies the browser's clipboard APIs.
 */
export function useFieldContextMenu(t: T, onError: (message: string) => void) {
  const [menu, setMenu] = useState<{
    x: number
    y: number
    field: TextField
    start: number
    end: number
    selected: string
    readOnly: boolean
  } | null>(null)

  const onContextMenu = useCallback((e: ReactMouseEvent) => {
    const field = editableAt(e.target)
    if (!field) return
    e.preventDefault()
    const { start, end, selected } = rangeOf(field)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      field,
      start,
      end,
      selected,
      readOnly: field.readOnly || field.disabled,
    })
  }, [])

  const close = () => setMenu(null)

  const items = (): ContextMenuItem[] => {
    if (!menu) return []
    const { field, start, end, selected, readOnly } = menu
    return [
      {
        label: t('cut'),
        icon: <Icon name="cut" size={14} />,
        disabled: readOnly || !selected,
        onSelect: () => {
          void copyText(selected).then(ok => {
            if (!ok) return onError(t('copyFailed'))
            replaceRange(field, start, end, '')
          })
        },
      },
      {
        label: t('copy'),
        icon: <Icon name="copy" size={14} />,
        disabled: !selected,
        onSelect: () => {
          void copyText(selected).then(ok => {
            if (!ok) onError(t('copyFailed'))
          })
        },
      },
      {
        label: t('paste'),
        icon: <Icon name="paste" size={14} />,
        disabled: readOnly,
        onSelect: () => {
          void readText().then(text => {
            if (text === null) return onError(t('pasteFailed'))
            if (text) replaceRange(field, start, end, text)
          })
        },
      },
      {
        label: t('selectAll'),
        icon: <Icon name="format" size={14} />,
        divider: true,
        onSelect: () => {
          field.focus()
          field.select()
        },
      },
    ]
  }

  const fieldMenu = menu ? (
    <ContextMenu x={menu.x} y={menu.y} items={items()} onClose={close} />
  ) : null

  return { fieldMenu, onFieldContextMenu: onContextMenu }
}
