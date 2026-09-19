import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { T } from '../lib/i18n'
import { buildTree, QUICK_ROOT_ID, type TreeNode } from '../lib/tree'
import type { CollectionNode, HistorySummary } from '../lib/types'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'

type Props = {
  t: T
  nodes: CollectionNode[]
  history: HistorySummary[]
  activeNodeId?: string
  /** The recorded exchange currently open, highlighted like a tree row. */
  activeHistoryId?: string
  onOpenRequest: (node: CollectionNode) => void
  onCreate: (parentId: string, type: 'folder' | 'request') => void
  onRename: (node: CollectionNode) => void
  onDelete: (node: CollectionNode) => void
  onOpenHistory: (entry: HistorySummary) => void
  onHistoryAction: (action: HistoryAction, entry: HistorySummary) => void
  onClearHistory: () => void
  onImportCurl: () => void
  onQuickRequest: () => void
  onCopyCurl: (node: CollectionNode) => void
  /** Persist a drag: re-parent when the drop crossed folders, then pin the
      destination's sibling order to exactly what the drop showed. */
  onMoveNode: (id: string, parentId: string, orderedIds: string[]) => void
}

/** Where a dragged row would land relative to the row under the pointer.
 *  `out` counts levels the landing sits above the hovered row's own level —
 *  the pull-left gesture — and only stretches the line, never moves it. */
type DropHint = { id: string; pos: 'above' | 'below' | 'into'; out?: number }

/** Pointer-driven drag wiring handed to every tree row. The gesture is
 *  tracked by hand: inside DBX's webview iframe the native HTML5 drag never
 *  delivers dragover/drop back to this document, so rows dragged but never
 *  landed. */
type DnD = {
  /** The row being dragged, for the dimmed look. */
  dragId: string | null
  hint: DropHint | null
  /** Arms a possible drag; the row keeps its click. */
  start: (node: TreeNode, e: ReactPointerEvent<HTMLDivElement>) => void
}

export type SidePane = 'apis' | 'history'

/** What a history row's context menu can do with a recorded exchange. */
export type HistoryAction = 'resend' | 'save' | 'curl' | 'url' | 'response' | 'code' | 'delete'

const methodClass = (method: string) => `m-${(method || 'GET').toLowerCase()}`

/** Depth of a node in the folder tree — roots sit at level 0. */
function depthOfNode(n: CollectionNode, flat: Map<string, CollectionNode>): number {
  let d = 0
  let cur: CollectionNode | undefined = n.parentId ? flat.get(n.parentId) : undefined
  while (cur && cur.type === 'folder') {
    d++
    cur = cur.parentId ? flat.get(cur.parentId) : undefined
  }
  return d
}

/**
 * When a history entry was sent: a clock time for today's requests, date and
 * time for older ones. The row tooltip carries the full timestamp.
 */
function sentAt(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const today =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  if (today) return time
  return `${date.toLocaleDateString([], { month: '2-digit', day: '2-digit' })} ${time.slice(0, 5)}`
}

/** Keep nodes whose own name or URL matches the query (folders pass if children survive). */
function filterTree(list: TreeNode[], q: string): TreeNode[] {
  return list
    .map(node => ({ ...node, children: filterTree(node.children, q) }))
    .filter(
      node =>
        node.children.length > 0 ||
        node.name.toLowerCase().includes(q) ||
        (node.url || '').toLowerCase().includes(q)
    )
}

export function Sidebar(props: Props) {
  const { t, history } = props
  const [pane, setPane] = useState<SidePane>('apis')
  const [historyMenu, setHistoryMenu] = useState<{
    x: number
    y: number
    entry: HistorySummary
  } | null>(null)
  const tabOf = (key: SidePane) => (pane === key ? 'sb-tab active' : 'sb-tab')
  return (
    <aside className="sb">
      <nav className="sb-tabs" aria-label="面板">
        <button className={tabOf('apis')} onClick={() => setPane('apis')}>
          <Icon name="api" size={13} />
          {t('collections')}
        </button>
        <button className={tabOf('history')} onClick={() => setPane('history')}>
          <Icon name="clock" size={13} />
          {t('history')}
        </button>
      </nav>
      {pane === 'apis' && <ApisPane {...props} />}
      {pane === 'history' && (
        <div className="panel-body">
          <div className="panel-head">
            <span className="panel-title">{t('history')}</span>
            <span className="spacer" />
            <button className="icon-btn" title={t('clearHistory')} onClick={props.onClearHistory}>
              <Icon name="trash" />
            </button>
          </div>
          <div className="rows">
            {history.map(entry => (
              <button
                key={entry.id}
                className={entry.id === props.activeHistoryId ? 'row current' : 'row'}
                onClick={() => props.onOpenHistory(entry)}
                onContextMenu={e => {
                  e.preventDefault()
                  setHistoryMenu({ x: e.clientX, y: e.clientY, entry })
                }}
              >
                <span className={`method ${methodClass(entry.method)}`}>{entry.method}</span>
                <span className="row-texts">
                  <span className="row-name">{entry.url}</span>
                  {/* Same-day entries read as a clock time; older ones need
                      the date. */}
                  <span className="row-sub">{sentAt(entry.createdAt)}</span>
                </span>
                <span className={entry.status >= 400 || entry.error ? 'st-bad' : 'st-ok'}>
                  {entry.error ? '!' : entry.status}
                </span>
              </button>
            ))}
            {!history.length && <div className="pane-empty">{t('noHistory')}</div>}
          </div>
          {historyMenu && (
            <ContextMenu
              x={historyMenu.x}
              y={historyMenu.y}
              onClose={() => setHistoryMenu(null)}
              items={[
                {
                  label: t('resend'),
                  icon: <Icon name="send" size={14} />,
                  onSelect: () => props.onHistoryAction('resend', historyMenu.entry),
                },
                {
                  label: t('saveAs'),
                  icon: <Icon name="folder" size={14} />,
                  onSelect: () => props.onHistoryAction('save', historyMenu.entry),
                },
                {
                  label: t('copyCurl'),
                  icon: <Icon name="copy" size={14} />,
                  onSelect: () => props.onHistoryAction('curl', historyMenu.entry),
                },
                {
                  label: t('copyUrl'),
                  icon: <Icon name="globe" size={14} />,
                  onSelect: () => props.onHistoryAction('url', historyMenu.entry),
                },
                {
                  label: t('copyResponse'),
                  icon: <Icon name="download" size={14} />,
                  // A transport failure has no response body to hand over.
                  disabled: !!historyMenu.entry.error,
                  onSelect: () => props.onHistoryAction('response', historyMenu.entry),
                },
                {
                  label: t('generateCode'),
                  icon: <Icon name="code" size={14} />,
                  onSelect: () => props.onHistoryAction('code', historyMenu.entry),
                },
                {
                  label: t('deleteHistoryEntry'),
                  icon: <Icon name="trash" size={14} />,
                  danger: true,
                  divider: true,
                  onSelect: () => props.onHistoryAction('delete', historyMenu.entry),
                },
              ]}
            />
          )}
        </div>
      )}
    </aside>
  )
}

function ApisPane(props: Props) {
  const { t, nodes } = props
  const [query, setQuery] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [quickOpen, setQuickOpen] = useState(true)
  const [moduleOpen, setModuleOpen] = useState(true)
  const [rowMenu, setRowMenu] = useState<{ x: number; y: number; node: TreeNode } | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])
  const searching = query.trim() !== ''
  const q = query.trim().toLowerCase()
  const treeNodes = useMemo(() => nodes.filter(n => n.parentId !== QUICK_ROOT_ID), [nodes])
  const quickNodes = useMemo(() => nodes.filter(n => n.parentId === QUICK_ROOT_ID), [nodes])
  const tree = useMemo(() => {
    const built = buildTree(treeNodes)
    return searching ? filterTree(built, q) : built
  }, [treeNodes, q, searching])
  const quick = useMemo(() => {
    const built = buildTree(quickNodes)
    return searching ? filterTree(built, q) : built
  }, [quickNodes, q, searching])
  const openRowMenu = (n: TreeNode, e: ReactMouseEvent) => {
    e.preventDefault()
    setRowMenu({ x: e.clientX, y: e.clientY, node: n })
  }
  // The row's overflow button opens the same menu the right-click does, anchored
  // under the button rather than at the cursor. One definition serves both ways
  // in, so the button can never offer something the right-click does not.
  const openRowMenuAtButton = (n: TreeNode, button: HTMLElement) => {
    const box = button.getBoundingClientRect()
    setRowMenu({ x: box.left, y: box.bottom + 4, node: n })
  }

  // Drag-and-drop inside one group at a time: quick requests reorder among
  // themselves, tree items reorder among their siblings or land in a folder.
  // Disabled while searching — the filtered list hides the ancestors a move
  // would have to name.
  const [dragId, setDragId] = useState<string | null>(null)
  const [hint, setHint] = useState<DropHint | null>(null)
  // The ghost that trails the pointer: positioned directly, so the move
  // handler never re-renders to follow it. Its box starts exactly on the
  // source row — same left, top and width — so it reads as that row lifted.
  const ghostRef = useRef<HTMLDivElement | null>(null)
  const ghostBase = useRef<{ left: number; top: number } | null>(null)
  const guideRef = useRef<HTMLDivElement | null>(null)
  const [ghostBox, setGhostBox] = useState<{ left: number; top: number; width: number } | null>(
    null
  )
  // The gesture lives in refs: the window listeners below read them without
  // re-binding on every render, while dragId/hint drive the look.
  const pending = useRef<{ id: string; x: number; y: number } | null>(null)
  const draggingRef = useRef(false)
  // Where the pointer entered the current row's bottom edge — the anchor the
  // pull-left gesture measures its indent columns from.
  const zone = useRef<{ id: string; entryX: number } | null>(null)
  const flat = useMemo(() => new Map(nodes.map(n => [n.id, n])), [nodes])
  const groupOf = (n: CollectionNode) => (n.parentId === QUICK_ROOT_ID ? 'quick' : 'module')
  // Ordered children of a parent, read from the built trees so the order on
  // screen is the order a drop sends to the backend.
  const childrenOf = (parentId: string): TreeNode[] => {
    if (parentId === QUICK_ROOT_ID) return quick
    if (parentId === '') return tree
    const stack = [...tree]
    while (stack.length) {
      const node = stack.pop()!
      if (node.id === parentId) return node.children
      stack.push(...node.children)
    }
    return []
  }
  const inSubtree = (folderId: string, nodeId: string) => {
    let cur: CollectionNode | undefined = flat.get(nodeId)
    while (cur) {
      if (cur.id === folderId) return true
      cur = cur.parentId ? flat.get(cur.parentId) : undefined
    }
    return false
  }
  /** What the pointer currently hovers during a drag, resolved by hit-test:
   *  a row to land on — with the position the drop would take — or a group
   *  header meaning "append to that group's root". */
  const hitTest = (
    x: number,
    y: number,
    draggedId: string,
    zone: { id: string; entryX: number } | null
  ): {
    kind: 'row'
    node: CollectionNode
    pos: 'above' | 'below' | 'into'
    /** The row the marker line draws on — the hovered row itself, even when
     *  the landing resolves to an ancestor level. */
    anchor: string
    out: number
    /** The tree level the landing sits at. */
    depth: number
    bottomZone: boolean
  } | {
    kind: 'group'
    group: 'quick' | 'module'
  } | null => {
    const dragged = flat.get(draggedId)
    if (!dragged) return null
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null
    const group = dragged.parentId === QUICK_ROOT_ID ? 'quick' : 'module'
    const head = el.closest('.group-head') as HTMLElement | null
    if (head) return head.dataset.group === group ? { kind: 'group' as const, group } : null
    let row = el.closest('.tree-row') as HTMLElement | null
    let node = row?.dataset.nodeId ? flat.get(row.dataset.nodeId) : undefined
    let forcedBottom = false
    // Empty pane below the rows still means "after the group's last row", so
    // the tail of a list keeps its line — and its way out.
    if (!node) {
      const kids = childrenOf(group === 'quick' ? QUICK_ROOT_ID : '')
      const last = kids.length ? kids[kids.length - 1] : undefined
      if (last) {
        node = last
        forcedBottom = true
        row = document.querySelector(
          `.tree-row[data-node-id="${last.id}"]`
        ) as HTMLElement | null
      }
    }
    if (!node || !row) return null
    // Hovering the dragged row itself is allowed on its lower edge: without a
    // pull it is a harmless no-op, and with one it is the way out of the
    // folder the row closes.
    const self = node.id === dragged.id
    if (!self && groupOf(node) !== group) return null
    if (!self && dragged.type === 'folder' && node.type !== 'folder') return null
    const box = row.getBoundingClientRect()
    const ratio = forcedBottom ? 1 : (y - box.top) / box.height
    const isLastChild = (parentId: string, childId: string) => {
      const kids = childrenOf(parentId)
      return kids.length > 0 && kids[kids.length - 1].id === childId
    }
    // On the bottom edge of the last row of a folder, pulling the pointer left
    // steps the landing OUT one level per indent column — anchored to where
    // the pointer entered this edge, so it reacts at once. The line never
    // moves: it only grows longer (shallower level) and shorter again.
    if (ratio > 0.7) {
      const baseX = zone && zone.id === node.id ? zone.entryX : x
      const k = Math.max(0, Math.floor((baseX - x) / 12))
      if (k > 0) {
        // Walk up while each ancestor folder ends with this row: only then is
        // "one level out" a drop past that folder.
        const chain: CollectionNode[] = []
        let child: CollectionNode = node
        let parent =
          child.parentId && child.parentId !== QUICK_ROOT_ID ? flat.get(child.parentId) : undefined
        while (parent && parent.type === 'folder' && isLastChild(parent.id, child.id)) {
          chain.push(parent)
          child = parent
          if (chain.length >= k) break
          parent =
            child.parentId && child.parentId !== QUICK_ROOT_ID ? flat.get(child.parentId) : undefined
        }
        const target = chain[chain.length - 1]
        if (target && !inSubtree(draggedId, target.id)) {
          return {
            kind: 'row' as const,
            node: target,
            pos: 'below' as const,
            anchor: node.id,
            depth: depthOfNode(node, flat),
            out: Math.min(k, chain.length),
            bottomZone: true,
          }
        }
      }
    }
    if (node.type === 'folder') {
      if (dragged.type === 'request') {
        // The lower edge lands the request OUTSIDE, after this folder in its
        // parent; anywhere else on the row files it inside. That is the way
        // out when the folder is the only root node there is.
        return {
          kind: 'row' as const,
          node,
          pos: ratio > 0.7 ? ('below' as const) : ('into' as const),
          anchor: node.id,
            depth: depthOfNode(node, flat),
          out: 0,
          bottomZone: ratio > 0.7,
        }
      }
      if (ratio < 0.3) return { kind: 'row' as const, node, pos: 'above' as const, anchor: node.id, out: 0, depth: depthOfNode(node, flat), bottomZone: false }
      if (ratio > 0.7) return { kind: 'row' as const, node, pos: 'below' as const, anchor: node.id, out: 0, depth: depthOfNode(node, flat), bottomZone: true }
      // A folder never swallows its own descendant.
      if (inSubtree(node.id, dragged.id)) return null
      return { kind: 'row' as const, node, pos: 'into' as const, anchor: node.id, out: 0, depth: depthOfNode(node, flat), bottomZone: false }
    }
    return {
      kind: 'row' as const,
      node,
      pos: ratio < 0.5 ? ('above' as const) : ('below' as const),
      anchor: node.id,
            depth: depthOfNode(node, flat),
      out: 0,
      bottomZone: ratio >= 0.5,
    }
  }
  const landOnRow = (
    dragged: CollectionNode,
    node: CollectionNode,
    pos: 'above' | 'below' | 'into'
  ) => {
    if (pos === 'into') {
      if (node.type !== 'folder' || inSubtree(node.id, dragged.id)) return
      props.onMoveNode(dragged.id, node.id, appendInto(node.id, dragged))
      return
    }
    const parentId = node.parentId ?? ''
    const sibs = childrenOf(parentId)
    const same = sibs.filter(c => c.type === dragged.type && c.id !== dragged.id)
    let at: number
    if (node.type === dragged.type) {
      at = same.findIndex(c => c.id === node.id)
      if (at < 0) return
      if (pos === 'below') at += 1
    } else {
      // Cross-type landing — a request on a folder's lower edge: it takes the
      // top of that parent's request block, right after the folders.
      at = 0
    }
    const ordered: CollectionNode[] = [...same.slice(0, at), dragged, ...same.slice(at)]
    props.onMoveNode(
      dragged.id,
      parentId,
      mergeSiblings(
        ordered.filter(c => c.type === 'folder'),
        ordered.filter(c => c.type === 'request')
      )
    )
  }
  // The window listeners are bound once per data change; the gesture state
  // they read and write lives in refs, the look in dragId/hint.
  useEffect(() => {
    if (searching) return
    const clear = () => {
      pending.current = null
      zone.current = null
      if (draggingRef.current) {
        draggingRef.current = false
        document.body.classList.remove('tree-dragging')
      }
      setDragId(null)
      setHint(null)
    }
    const move = (e: PointerEvent) => {
      const armed = pending.current
      if (!armed) {
        // A drag whose pointerup landed outside the iframe never hears the
        // event — the first pointer movement afterwards clears its remains.
        if (dragId !== null) clear()
        return
      }
      if (!draggingRef.current) {
        // A click travels less than the threshold; past it, it is a drag.
        if (Math.hypot(e.clientX - armed.x, e.clientY - armed.y) < 6) return
        draggingRef.current = true
        setDragId(armed.id)
        document.body.classList.add('tree-dragging')
        // The ghost starts on the source row itself — its exact left, top and
        // width — then tracks the pointer one to one.
        const row = document.querySelector(
          `.tree-row[data-node-id="${armed.id}"]`
        ) as HTMLElement | null
        const rect = row?.getBoundingClientRect()
        if (rect) {
          ghostBase.current = { left: rect.left, top: rect.top }
          setGhostBox({ left: rect.left, top: rect.top, width: rect.width })
        } else {
          ghostBase.current = { left: e.clientX, top: e.clientY }
          setGhostBox(null)
        }
      }
      if (ghostRef.current && ghostBase.current) {
        ghostRef.current.style.left = `${ghostBase.current.left + (e.clientX - armed.x)}px`
        ghostRef.current.style.top = `${ghostBase.current.top + (e.clientY - armed.y)}px`
      }
      e.preventDefault()
      const hit = hitTest(e.clientX, e.clientY, armed.id, zone.current)
      const dragged = flat.get(armed.id)
      // The vertical rail appears whenever the landing sits at a different
      // tree level than the dragged node's own — the level change made
      // visible. It hangs from the receiving folder (the ancestor named by
      // the pull-left, or the hovered row's parent), or from the list top at
      // root, and runs down to the marker line.
      if (guideRef.current) {
        const depthChanged =
          !!hit &&
          hit.kind === 'row' &&
          hit.pos !== 'into' &&
          !!dragged &&
          hit.depth !== depthOfNode(dragged, flat)
        if (depthChanged && hit.kind === 'row') {
          const rowEl = document.querySelector(`.tree-row[data-node-id="${hit.anchor}"]`)
          const listEl = rowEl?.closest('.rows')
          const railAnchorId =
            hit.out > 0
              ? hit.node.id
              : hit.node.parentId && hit.node.parentId !== QUICK_ROOT_ID
                ? hit.node.parentId
                : null
          const railEl = railAnchorId
            ? (document.querySelector(
                `.tree-row[data-node-id="${railAnchorId}"]`
              ) as HTMLElement | null)
            : null
          if (rowEl && listEl) {
            const r = rowEl.getBoundingClientRect()
            const c = listEl.getBoundingClientRect()
            const indent = parseFloat(getComputedStyle(rowEl).getPropertyValue('--indent')) || 18
            const railRect = railEl?.getBoundingClientRect()
            const top = railRect ? Math.max(railRect.top + railRect.height / 2, c.top) : c.top
            guideRef.current.style.display = 'block'
            guideRef.current.style.left = `${r.left + indent - hit.out * 12 - 0.5}px`
            guideRef.current.style.top = `${top}px`
            guideRef.current.style.height = `${Math.max(0, Math.min(r.bottom, c.bottom) - top)}px`
          }
        } else {
          guideRef.current.style.display = 'none'
        }
      }
      if (hit && hit.kind === 'row') {
        setHint(
          h =>
            h &&
            h.id === hit.anchor &&
            h.pos === hit.pos &&
            (h.out ?? 0) === hit.out
              ? h
              : { id: hit.anchor, pos: hit.pos, out: hit.out }
        )
        // The pull-left anchor is set when the pointer enters a row's bottom
        // edge, and forgotten the moment it leaves that edge again.
        if (hit.bottomZone) {
          if (zone.current?.id !== hit.anchor) zone.current = { id: hit.anchor, entryX: e.clientX }
        } else {
          zone.current = null
        }
      } else {
        setHint(h => (h === null ? h : null))
        zone.current = null
      }
    }
    const up = (e: PointerEvent) => {
      const armed = pending.current
      const wasDragging = draggingRef.current
      // The anchor must survive clear(): the landing is recomputed from it.
      const z = zone.current
      clear()
      if (!armed || !wasDragging) return
      const hit = hitTest(e.clientX, e.clientY, armed.id, z)
      if (!hit) return
      const dragged = flat.get(armed.id)
      if (!dragged) return
      if (hit.kind === 'row') landOnRow(dragged, hit.node, hit.pos)
      else dropGroupInto(hit.group, dragged)
    }
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    // The webview hands a drag that leaves the iframe to its host, and the
    // pointerup never comes back — drop the gesture at the boundary instead
    // of leaving a stuck ghost over the rows.
    const docLeave = () => {
      if (draggingRef.current) clear()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', clear)
    window.addEventListener('keydown', cancel)
    window.addEventListener('blur', docLeave)
    document.addEventListener('pointerleave', docLeave)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', clear)
      window.removeEventListener('keydown', cancel)
      window.removeEventListener('blur', docLeave)
      document.removeEventListener('pointerleave', docLeave)
    }
  })
  const dropGroupInto = (group: 'quick' | 'module', dragged: CollectionNode) => {
    const parentId = group === 'quick' ? QUICK_ROOT_ID : ''
    const roots = childrenOf(parentId).filter(c => c.id !== dragged.id)
    const folders = roots.filter(c => c.type === 'folder')
    const requests = roots.filter(c => c.type === 'request')
    props.onMoveNode(
      dragged.id,
      parentId,
      dragged.type === 'folder'
        ? mergeSiblings([...folders, dragged], requests)
        : mergeSiblings(folders, [...requests, dragged])
    )
  }
  const dnd: DnD | undefined = searching
    ? undefined
    : {
        dragId,
        hint,
        start: (node, e) => {
          if (e.button !== 0) return
          // The row's buttons own their presses: the chevron toggles, the ops
          // button opens a menu — neither turns into a drag.
          if ((e.target as HTMLElement).closest('button')) return
          // Capture the pointer: the webview would otherwise keep a drag that
          // leaves the iframe to itself and never deliver the pointerup.
          try {
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          } catch {
            /* capture is best-effort */
          }
          pending.current = { id: node.id, x: e.clientX, y: e.clientY }
        },
      }
  // A drop lands the dragged node among its own kind — folders always sort
  // ahead of requests, so a request never lands above one and a folder never
  // below one. Each kind keeps the relative order the drop determined.
  const mergeSiblings = (folders: CollectionNode[], requests: CollectionNode[]) => [
    ...folders.map(c => c.id),
    ...requests.map(c => c.id),
  ]
  // Dropping onto a folder row appends inside it: the dragged node is pulled
  // out of its old slot first, so re-filing a request into the folder that
  // already holds it is a plain move, not a duplicate.
  const appendInto = (folderId: string, dragged: CollectionNode) => {
    const kids = childrenOf(folderId).filter(c => c.id !== dragged.id)
    const folders = kids.filter(c => c.type === 'folder')
    const requests = kids.filter(c => c.type === 'request')
    return dragged.type === 'folder'
      ? mergeSiblings([...folders, dragged], requests)
      : mergeSiblings(folders, [...requests, dragged])
  }
  return (
    <div className="panel-body">
      <div className="panel-head">
        <span className="spacer" />
        <div className="add-menu" ref={menuRef}>
          <button
            className={menuOpen ? 'icon-btn accent menu-open' : 'icon-btn accent'}
            title={t('add')}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(o => !o)}
          >
            <Icon name="plus" />
          </button>
          {menuOpen && (
            <div className="menu" role="menu">
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  props.onCreate('', 'folder')
                }}
              >
                <Icon name="folder" size={14} />
                {t('newFolder')}
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false)
                  props.onQuickRequest()
                }}
              >
                <Icon name="file" size={14} />
                {t('newRequest')}
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="panel-search">
        <Icon name="search" className="search-ico" />
        <input className="dbx-input" value={query} placeholder={t('search')} onChange={e => setQuery(e.target.value)} />
      </div>
      <div className="rows">
        <div
          className="group-head"
          role="button"
          aria-expanded={moduleOpen || searching}
          data-group="module"
          onClick={() => setModuleOpen(o => !o)}
        >
          <Icon name={moduleOpen || searching ? 'chevron-down' : 'chevron-right'} size={12} />
          {t('defaultModule')}
        </div>
        {(moduleOpen || searching) && (
          <>
            {tree.map(node => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                {...props}
                dnd={dnd}
                onRowContextMenu={openRowMenu}
                onRowMenuButton={openRowMenuAtButton}
              />
            ))}
            {!tree.length && <div className="pane-empty">{t('noApis')}</div>}
          </>
        )}
        <div
          className="group-head"
          role="button"
          aria-expanded={quickOpen || searching}
          data-group="quick"
          onClick={() => setQuickOpen(o => !o)}
        >
          <Icon name={quickOpen || searching ? 'chevron-down' : 'chevron-right'} size={12} />
          {t('quickRequests')}
        </div>
        {(quickOpen || searching) && (
          <>
            {quick.map(node => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                {...props}
                dnd={dnd}
                onRowContextMenu={openRowMenu}
                onRowMenuButton={openRowMenuAtButton}
              />
            ))}
            {!quick.length && <div className="pane-empty">{t('quickEmpty')}</div>}
          </>
        )}
      </div>
      {(() => {
        const dragged = dragId ? flat.get(dragId) : undefined
        if (!dragged) return null
        return (
          // A translucent stand-in of the carried row that trails the pointer.
          // pointer-events:none keeps it out of the drop hit-test.
          <div
            className="drag-ghost"
            ref={ghostRef}
            style={
              ghostBox
                ? { left: ghostBox.left, top: ghostBox.top, width: ghostBox.width }
                : undefined
            }
          >
            {dragged.type === 'request' ? (
              <span className={`method ${methodClass(dragged.method || 'GET')}`}>
                {dragged.method || 'GET'}
              </span>
            ) : (
              <Icon name="folder" size={14} />
            )}
            <span className="drag-ghost-name">{dragged.name}</span>
          </div>
        )
      })()}
      {dragId && <div className="drop-guide" ref={guideRef} aria-hidden="true" />}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => setRowMenu(null)}
          items={
            rowMenu.node.type === 'folder'
              ? [
                  {
                    label: t('newRequest'),
                    icon: <Icon name="plus" size={14} />,
                    onSelect: () => props.onCreate(rowMenu.node.id, 'request'),
                  },
                  {
                    label: t('rename'),
                    icon: <Icon name="edit" size={14} />,
                    onSelect: () => props.onRename(rowMenu.node),
                  },
                  {
                    label: t('delete'),
                    icon: <Icon name="trash" size={14} />,
                    danger: true,
                    onSelect: () => props.onDelete(rowMenu.node),
                  },
                ]
              : [
                  {
                    label: t('copyCurl'),
                    icon: <Icon name="copy" size={14} />,
                    onSelect: () => props.onCopyCurl(rowMenu.node),
                  },
                  {
                    label: t('rename'),
                    icon: <Icon name="edit" size={14} />,
                    onSelect: () => props.onRename(rowMenu.node),
                  },
                  {
                    label: t('delete'),
                    icon: <Icon name="trash" size={14} />,
                    danger: true,
                    onSelect: () => props.onDelete(rowMenu.node),
                  },
                ]
          }
        />
      )}
    </div>
  )
}

type TreeRowProps = Props & {
  node: TreeNode
  depth: number
  dnd?: DnD
  onRowContextMenu: (node: TreeNode, e: ReactMouseEvent) => void
  /** Opens the row's menu from its overflow button, anchored under it. */
  onRowMenuButton: (node: TreeNode, button: HTMLElement) => void
}

/** Requests under a folder, nested ones included — the total a group heading
 *  used to carry, now living on the folder it belongs to. */
function requestCount(node: TreeNode): number {
  return node.children.reduce(
    (sum, child) => sum + (child.type === 'folder' ? requestCount(child) : 1),
    0
  )
}

function TreeRow(props: TreeRowProps) {
  const { node, depth, t } = props
  const dnd = props.dnd
  const [open, setOpen] = useState(depth === 0)
  const current = node.type === 'request' && node.id === props.activeNodeId
  const dropClass =
    dnd?.hint && dnd.hint.id === node.id ? ` drop-${dnd.hint.pos}` : ''
  const dropOut = dnd?.hint && dnd.hint.id === node.id ? dnd.hint.out ?? 0 : 0
  return (
    <>
      <div
        className={`row tree-row${current ? ' current' : ''}${dropClass}${
          dnd?.dragId === node.id ? ' dragging' : ''
        }`}
        data-node-id={node.id}
        // Rows indent one level under the group heading (the heading is the
        // virtual root), then one 12px step per depth. The indent is also the
        // drop line's starting edge, so deeper drops draw a shorter line —
        // and --drop-out stretches it back while the pointer pulls left.
        style={
          {
            '--indent': `${6 + (depth + 1) * 12}px`,
            '--drop-out': dropOut,
          } as React.CSSProperties
        }
        onClick={() => {
          if (node.type === 'request') props.onOpenRequest(node)
          else setOpen(o => !o)
        }}
        onPointerDown={dnd ? e => dnd.start(node, e) : undefined}
        onContextMenu={e => props.onRowContextMenu(node, e)}
      >
        {node.type === 'folder' ? (
          <button
            className="tw"
            aria-label={open ? t('collapse') : t('expand')}
            onClick={e => {
              e.stopPropagation()
              setOpen(o => !o)
            }}
          >
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
          </button>
        ) : (
          <span className="tw placeholder" />
        )}
        <span className="row-ico">
          {node.type === 'folder' ? (
            <Icon name={open ? 'folder-open' : 'folder'} size={14} />
          ) : (
            <span className={`method ${methodClass(node.method || 'GET')}`}>
              {node.method || 'GET'}
            </span>
          )}
        </span>
        <span className="row-texts">
          {node.type === 'folder' ? (
            // The count reads as part of the title — "目录 (3)" — but sits
            // outside the ellipsised span so truncation eats the name, never
            // the number.
            <span className="row-name-line">
              <span className="row-name">{node.name}</span>
              <span className="row-count">({requestCount(node)})</span>
            </span>
          ) : (
            <span className="row-name">{node.name}</span>
          )}
        </span>
        <span className="row-ops" onClick={e => e.stopPropagation()}>
          {/* One overflow button instead of a copy/rename/delete trio: three
              icons on every row crowded the name and left less room for it,
              and the same actions are already a right-click away. */}
          <button
            className="icon-btn"
            title={t('moreActions')}
            aria-haspopup="menu"
            aria-label={t('moreActions')}
            onClick={e => props.onRowMenuButton(node, e.currentTarget)}
          >
            <Icon name="more" size={14} />
          </button>
        </span>
      </div>
      {open &&
        node.children.map(child => (
          <TreeRow key={child.id} {...props} node={child} depth={depth + 1} />
        ))}
    </>
  )
}
