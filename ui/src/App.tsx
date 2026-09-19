import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { CodeDialog } from './components/CodeDialog'
import { ContextMenu } from './components/ContextMenu'
import { Dialog, useDialogState } from './components/Dialog'
import { EnvDialog } from './components/EnvDialog'
import { useFieldContextMenu } from './components/FieldContextMenu'
import { Icon } from './components/Icon'
import { RequestPanel } from './components/RequestPanel'
import { ResponsePanel } from './components/ResponsePanel'
import { SaveAsDialog, type FolderOption } from './components/SaveAsDialog'
import { Sidebar, type HistoryAction } from './components/Sidebar'
import { TooltipLayer, useTooltips } from './components/Tooltip'
import { errorText, useBridgeHost } from './lib/bridge'
import { copyText } from './lib/clipboard'
import { buildCurl } from './lib/curl'
import {
  loadActiveEnvId,
  loadEnvironments,
  presetEnvironments,
  resolveUrl,
  saveActiveEnvId,
  saveEnvironments,
  type Environment,
} from './lib/environments'
import { langOf, makeT } from './lib/i18n'
import { buildTree, effectiveUrl, QUICK_ROOT_ID, type TreeNode } from './lib/tree'
import type {
  CollectionNode,
  HistoryRecord,
  HistorySummary,
  RequestSpec,
  Response,
} from './lib/types'

type Tab = {
  key: string
  nodeId?: string
  /** Set when the tab replays a recorded exchange from the history pane. */
  historyId?: string
  name: string
  spec: RequestSpec
  response: Response | null
  /** The replay's response body was shortened to fit the history file. */
  bodyOmitted?: boolean
  /** Bumped by a cURL import that brought a body: show the body editor. */
  revealBody?: number
  sending: boolean
  dirty: boolean
  /** Pinned tabs lead the strip and cannot be closed. */
  pinned?: boolean
}

let tabSeq = 0
const newKey = () => `t${++tabSeq}-${Date.now()}`

/** Widest the tree pane may be dragged, however wide the window gets. */
const MAX_SIDEBAR_WIDTH = 640
/** Room kept for the request editor when the pane span is the limit. */
const MIN_EDITOR_WIDTH = 320

/** Within this many pixels of a pane's default size, a drag sticks to it. */
const SNAP_TOLERANCE = 18

/** Persist a UI preference; private mode can refuse storage. */
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

/**
 * Splitter gesture shared by both panes: reports the dragged pane's next size,
 * clamped between min and max, until the pointer is released. A size that lands
 * within SNAP_TOLERANCE of the pane's default sticks to it, so the way back to
 * the starting size is magnetic rather than pixel-perfect. Pointer capture
 * keeps moves flowing across nested elements; leaving the document or window
 * ends the drag cleanly instead of sticking.
 */
function startResize(
  e: ReactPointerEvent,
  options: {
    axis: 'x' | 'y'
    size: number
    min: number
    max: number
    /** Default size to snap to, when it is inside the clamp range. */
    snap: number
    onResize: (size: number) => void
    onEnd: () => void
  }
) {
  const { axis, size, min, max, snap, onResize, onEnd } = options
  const snappable = snap >= min && snap <= max
  const grip = e.currentTarget as HTMLElement
  e.preventDefault()
  const start = axis === 'x' ? e.clientX : e.clientY
  let stuck = false
  const move = (ev: PointerEvent) => {
    const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
    let next = Math.min(Math.max(size + delta, min), max)
    const onSnap = snappable && Math.abs(next - snap) <= SNAP_TOLERANCE
    if (onSnap) next = snap
    // The grip swells while the pane sits on its default, so the magnet is
    // visible and not only felt.
    if (onSnap !== stuck) {
      stuck = onSnap
      grip.classList.toggle('snapped', onSnap)
    }
    onResize(next)
  }
  const end = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', end)
    window.removeEventListener('blur', end)
    document.documentElement.removeEventListener('mouseleave', end)
    document.body.classList.remove(axis === 'x' ? 'dragging-x' : 'dragging')
    grip.classList.remove('snapped')
    onEnd()
  }
  document.body.classList.add(axis === 'x' ? 'dragging-x' : 'dragging')
  e.currentTarget.setPointerCapture?.(e.pointerId)
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', end)
  window.addEventListener('blur', end)
  document.documentElement.addEventListener('mouseleave', end)
}

/** How wide the tree pane may get inside a pane span of `span` pixels. */
function sidebarSpan(span: number) {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(240, span - MIN_EDITOR_WIDTH))
}

/** True when an imported request carries something for the body editor. */
const hasBody = (spec: RequestSpec) => !!spec.body && spec.body.type !== 'none'

/** The tab a recorded exchange opens into. */
function replayTab(item: HistoryRecord) {
  return {
    historyId: item.id,
    name: item.request.url || item.request.method,
    spec: item.request,
    response: item.response ?? null,
    bodyOmitted: item.responseBodyOmitted,
  }
}

export default function App() {
  const host = useBridgeHost()
  const t = useMemo(() => makeT(langOf(host.locale)), [host.locale])
  const { prompt, askText, askConfirm, close } = useDialogState()
  const [nodes, setNodes] = useState<CollectionNode[]>([])
  const [history, setHistory] = useState<HistorySummary[]>([])
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeKey, setActiveKey] = useState('')
  const [notice, setNotice] = useState('')
  const [codeFor, setCodeFor] = useState<RequestSpec | null>(null)
  const [saveAsTab, setSaveAsTab] = useState<Tab | null>(null)
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; tab: Tab } | null>(null)

  // Environments are named base URLs; the active one folds into relative
  // request URLs at send time. Like the pane sizes, they live in
  // localStorage — they are editor config, not project data.
  const [environments, setEnvironments] = useState<Environment[]>(loadEnvironments)
  const [activeEnvId, setActiveEnvId] = useState(loadActiveEnvId)
  const [envConfigOpen, setEnvConfigOpen] = useState(false)
  const activeEnv = environments.find(env => env.id === activeEnvId)
  const updateEnvironments = (list: Environment[]) => {
    setEnvironments(list)
    saveEnvironments(list)
  }
  const activateEnv = (id: string) => {
    setActiveEnvId(id)
    saveActiveEnvId(id)
  }
  const openEnvConfig = () => {
    // First open seeds the three starter environments; the locale is known by
    // then, so their names read like the rest of the UI.
    if (!environments.length) updateEnvironments(presetEnvironments(langOf(host.locale)))
    setEnvConfigOpen(true)
  }
  /** A URL to send or show in generated code, with the environment folded in. */
  const withEnv = (url: string) => resolveUrl(activeEnv?.baseUrl, url)
  const { fieldMenu, onFieldContextMenu } = useFieldContextMenu(t, setNotice)
  const tooltip = useTooltips()
  // Right-click belongs to the plugin everywhere: own menus handle the text
  // fields here plus the tree, history and tab rows, and anywhere else must not
  // fall through to the browser's native menu.
  const openContextMenu = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault()
      onFieldContextMenu(e)
    },
    [onFieldContextMenu]
  )

  // Folder options for 保存为接口, flattened in tree order with depths.
  const folderOptions = useMemo(() => {
    const out: FolderOption[] = []
    const walk = (list: TreeNode[], depth: number) =>
      list.forEach(node => {
        if (node.type !== 'folder') return
        out.push({ id: node.id, name: node.name, depth })
        walk(node.children, depth + 1)
      })
    walk(buildTree(nodes.filter(n => n.parentId !== QUICK_ROOT_ID)), 0)
    return out
  }, [nodes])

  // Draggable editor/response split, persisted per browser session store.
  // Strictly relative: growing one side shrinks the other, and both ends go all
  // the way — the response covers the request body down to the tab strip's
  // underline, or collapses to nothing (just the splitter left at the bottom).
  const DEFAULT_EDITOR_HEIGHT = 320
  /** Hard floor, and the fallback when the tab strip cannot be measured. */
  const MIN_EDITOR_HEIGHT = 48
  const DEFAULT_SIDEBAR_WIDTH = 264
  const editorHeightRef = useRef(DEFAULT_EDITOR_HEIGHT)
  const [editorHeight, setEditorHeight] = useState(() => {
    const stored = Number(localStorage.getItem('dbx-nintyapi:editorHeight'))
    // A stored height can outgrow the window it is restored into; the response
    // pane would then never be reachable until the splitter is dragged again.
    const ceiling = Math.max(MIN_EDITOR_HEIGHT, window.innerHeight - 60)
    const value =
      Number.isFinite(stored) && stored >= MIN_EDITOR_HEIGHT
        ? Math.min(stored, ceiling)
        : DEFAULT_EDITOR_HEIGHT
    editorHeightRef.current = value
    return value
  })
  const mainRef = useRef<HTMLElement | null>(null)
  // How far the editor can be squeezed before the response starts covering it:
  // measured down to the request tab strip's underline, so the body is fully
  // covered when the splitter is dragged to the top.
  const editorFloor = () => {
    const wrap = mainRef.current?.querySelector('.editor-wrap')
    const strip = mainRef.current?.querySelector('.req-tabs')
    if (!wrap || !strip) return MIN_EDITOR_HEIGHT
    const height = strip.getBoundingClientRect().bottom - wrap.getBoundingClientRect().top
    return Math.max(MIN_EDITOR_HEIGHT, Math.round(height))
  }
  // The editor height at which the response is reduced to its first row — the
  // status line and its buttons stay readable, everything below is covered.
  // Measured rather than computed, so it holds for whichever response state
  // (result, error, empty) is on screen.
  const editorCollapseHeight = () => {
    const main = mainRef.current
    const wrap = main?.querySelector('.editor-wrap')
    const response = main?.querySelector('.resp')
    const head = response?.firstElementChild
    if (!wrap || !response || !head) return null
    const style = window.getComputedStyle(response)
    const keep =
      head.getBoundingClientRect().bottom -
      response.getBoundingClientRect().top +
      (parseFloat(style.paddingBottom) || 0)
    return Math.max(
      editorFloor() + 20,
      Math.round(wrap.getBoundingClientRect().height + response.getBoundingClientRect().height - keep)
    )
  }
  const startEditorDrag = useCallback((e: ReactPointerEvent) => {
    const main = mainRef.current
    const floor = editorFloor()
    const collapse =
      editorCollapseHeight() ?? Math.max(floor + 20, (main?.getBoundingClientRect().height ?? 640) - 96)
    startResize(e, {
      axis: 'y',
      size: editorHeightRef.current,
      min: floor,
      max: collapse,
      snap: DEFAULT_EDITOR_HEIGHT,
      onResize: next => {
        editorHeightRef.current = next
        setEditorHeight(next)
        // Parking the splitter at the bottom is a collapse too — but only for
        // a pane that has a status row to keep; the empty hint stays put.
        setResponseCollapsed(
          next >= collapse - 1 && !!main?.querySelector('.resp-head')
        )
      },
      onEnd: () => remember('dbx-nintyapi:editorHeight', String(editorHeightRef.current)),
    })
  }, [])
  const resetEditorHeight = useCallback(() => {
    editorHeightRef.current = DEFAULT_EDITOR_HEIGHT
    setEditorHeight(DEFAULT_EDITOR_HEIGHT)
    remember('dbx-nintyapi:editorHeight', String(DEFAULT_EDITOR_HEIGHT))
  }, [])

  // Collapsing the response to its status line, and back to the height it had
  // before. The flag tracks what the user asked for — the button below, or
  // parking the splitter at the bottom — never a pane that merely looks short
  // (an empty response sits low too, and must keep showing its hint).
  const [responseCollapsed, setResponseCollapsed] = useState(false)
  const restoreHeightRef = useRef(DEFAULT_EDITOR_HEIGHT)
  const toggleResponse = useCallback(() => {
    const collapse = editorCollapseHeight()
    if (collapse === null) return
    if (editorHeightRef.current >= collapse - 1) {
      editorHeightRef.current = restoreHeightRef.current
      setEditorHeight(restoreHeightRef.current)
      remember('dbx-nintyapi:editorHeight', String(restoreHeightRef.current))
      setResponseCollapsed(false)
      return
    }
    restoreHeightRef.current = editorHeightRef.current
    editorHeightRef.current = collapse
    setEditorHeight(collapse)
    remember('dbx-nintyapi:editorHeight', String(collapse))
    setResponseCollapsed(true)
  }, [])

  // Tree pane width, dragged the same way. Dragging right widens the tree up
  // to its cap; dragging left slides the editor over it, one pixel at a time,
  // until the tree is fully covered — the rows never reflow under that edge.
  const columnsRef = useRef<HTMLDivElement | null>(null)
  const sidebarWidthRef = useRef(DEFAULT_SIDEBAR_WIDTH)
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = localStorage.getItem('dbx-nintyapi:sidebarWidth')
    const parsed = stored === null ? Number.NaN : Number(stored)
    // 0 is a stored value too — a collapsed pane stays collapsed.
    const value =
      Number.isFinite(parsed) && parsed >= 0
        ? Math.min(parsed, MAX_SIDEBAR_WIDTH)
        : DEFAULT_SIDEBAR_WIDTH
    sidebarWidthRef.current = value
    return value
  })
  const startSidebarDrag = useCallback((e: ReactPointerEvent) => {
    const bounds = columnsRef.current?.getBoundingClientRect()
    const span = bounds?.width || window.innerWidth
    startResize(e, {
      axis: 'x',
      size: sidebarWidthRef.current,
      min: 0,
      max: sidebarSpan(span),
      snap: DEFAULT_SIDEBAR_WIDTH,
      onResize: next => {
        sidebarWidthRef.current = next
        setSidebarWidth(next)
      },
      onEnd: () => remember('dbx-nintyapi:sidebarWidth', String(sidebarWidthRef.current)),
    })
  }, [])
  const resetSidebarWidth = useCallback(() => {
    sidebarWidthRef.current = DEFAULT_SIDEBAR_WIDTH
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)
    remember('dbx-nintyapi:sidebarWidth', String(DEFAULT_SIDEBAR_WIDTH))
  }, [])

  // host is a fresh object on every render; only depend on its stable members
  // here, otherwise invoke → reload → the load effect would re-run forever.
  const { invoke: rawInvoke, connectionId } = host
  const invoke = useCallback(
    async <T_,>(method: string, params: Record<string, unknown> = {}) =>
      rawInvoke<T_>(method, { ...params, connectionId }),
    [rawInvoke, connectionId]
  )

  const reload = useCallback(async () => {
    if (!connectionId) return
    const [c, h] = await Promise.allSettled([
      invoke<{ items: CollectionNode[] }>('collection/list'),
      invoke<{ items: HistorySummary[] }>('history/list', { limit: 50 }),
    ])
    if (c.status === 'fulfilled') setNodes(c.value.items || [])
    if (h.status === 'fulfilled') setHistory(h.value.items || [])
  }, [connectionId, invoke])

  useEffect(() => {
    setTabs([])
    setActiveKey('')
    void reload()
  }, [connectionId, reload])

  // Tree drag-and-drop: persist a re-parent (when the drop crossed folders —
  // the backend appends the node to its new siblings) and then pin the
  // destination parent's sibling order to exactly what the drop showed.
  const moveNode = useCallback(
    async (id: string, parentId: string, orderedIds: string[]) => {
      const node = nodes.find(n => n.id === id)
      if (!node) return
      try {
        if ((node.parentId ?? '') !== parentId) {
          await invoke('collection/save', { item: { ...node, parentId } })
        }
        const r = await invoke<{ items: CollectionNode[] }>('collection/reorder', {
          parentId,
          ids: orderedIds,
        })
        setNodes(r.items || [])
      } catch (error) {
        setNotice(errorText(error))
      }
    },
    [nodes, invoke]
  )

  const patchTab = (key: string, patch: Partial<Tab>) =>
    setTabs(old => old.map(tab => (tab.key === key ? { ...tab, ...patch } : tab)))

  const openTab = (partial: Partial<Tab> & { spec: RequestSpec; name: string }) => {
    const existing = partial.nodeId
      ? tabs.find(tab => tab.nodeId === partial.nodeId)
      : partial.historyId
        ? tabs.find(tab => tab.historyId === partial.historyId)
        : undefined
    if (existing) {
      setActiveKey(existing.key)
      return existing
    }
    const tab: Tab = {
      key: newKey(),
      nodeId: partial.nodeId,
      historyId: partial.historyId,
      name: partial.name,
      spec: partial.spec,
      response: partial.response ?? null,
      bodyOmitted: partial.bodyOmitted,
      revealBody: partial.revealBody,
      sending: false,
      dirty: false,
    }
    // A new tab lands at the end of the strip, the way a browser does it.
    // Pinned tabs keep leading because they are already there and only
    // togglePin reorders — appending never disturbs them.
    setTabs(old => [...old, tab])
    setActiveKey(tab.key)
    return tab
  }

  const active = tabs.find(tab => tab.key === activeKey)

  // Closing a tab hands focus to its neighbour, preferring the one on the
  // right so a run of closes walks leftwards the way editors behave.
  const closeTab = (key: string) => {
    const index = tabs.findIndex(tab => tab.key === key)
    if (index < 0) return
    // A pinned tab stays: the point of pinning is that it cannot be closed by
    // accident, so the close path refuses it rather than the UI merely hiding
    // the button.
    if (tabs[index].pinned) return
    const rest = tabs.filter(tab => tab.key !== key)
    setTabs(rest)
    if (key === activeKey) {
      const next = rest[Math.min(index, rest.length - 1)]
      setActiveKey(next ? next.key : '')
    }
  }

  // `closeTabs` clears the strip down to one tab, or to the pinned run when the
  // user asked to keep nothing — pinned tabs survive either way.
  const closeTabs = (keep?: string) => {
    const rest = tabs.filter(tab => tab.pinned || tab.key === keep)
    setTabs(rest)
    // The tab we kept stays in front; when it was a pinned tab that got closed
    // as part of "close all", a surviving pinned tab takes focus rather than
    // dropping the user onto the empty-state screen.
    setActiveKey(rest.some(tab => tab.key === keep) ? keep! : (rest[0]?.key ?? ''))
  }

  /** Pin or unpin a tab, keeping the pinned run in front. */
  const togglePin = (key: string) => {
    setTabs(old => {
      const target = old.find(t => t.key === key)
      if (!target) return old
      const pinned = !target.pinned
      const next = old.map(t => (t.key === key ? { ...t, pinned } : t))
      // Stable partition: pinned first, each run keeping its own order.
      return [...next.filter(t => t.pinned), ...next.filter(t => !t.pinned)]
    })
  }

  const send = async (tab: Tab) => {
    patchTab(tab.key, { sending: true })
    try {
      const response = await invoke<Response>('http/request', {
        ...tab.spec,
        url: withEnv(effectiveUrl(tab.spec)),
        queryParams: undefined,
      })
      // A fresh exchange replaces the replay's stored response.
      patchTab(tab.key, { response, sending: false, bodyOmitted: false })
      void reload()
    } catch (error) {
      setNotice(String((error as Error).message || error))
      patchTab(tab.key, { sending: false })
    }
  }

  // Re-run the request for a tab without making it active first: send() patches
  // by key, so it is safe to fire against any tab.
  const reloadTab = (tab: Tab) => void send(tab)

  // A history row's context menu. Two of the actions only need the row itself;
  // the rest replay the recorded exchange, which is fetched on demand — the
  // list carries no bodies.
  const historyAction = (action: HistoryAction, entry: HistorySummary) => {
    const copied = (text: string) =>
      void copyText(text).then(ok => setNotice(ok ? t('copied') : t('copyFailed')))
    if (action === 'url') return copied(entry.url)
    if (action === 'delete') {
      invoke('history/delete', { id: entry.id })
        .then(() => reload())
        .catch(error => setNotice(errorText(error)))
      return
    }
    invoke<{ item: HistoryRecord }>('history/get', { id: entry.id })
      .then(({ item }) => {
        const replay = replayTab(item)
        switch (action) {
          case 'resend': {
            // Reuse the tab this entry already opened, so a resend does not
            // stack duplicates of the same request.
            const tab = tabs.find(candidate => candidate.historyId === item.id) ?? openTab(replay)
            setActiveKey(tab.key)
            void send(tab)
            return
          }
          case 'save':
            // A throwaway tab: the dialog only needs a spec to save, and it
            // must not disturb the replay tab this entry may already have.
            setSaveAsTab({
              ...replay,
              key: `history-${item.id}`,
              response: null,
              bodyOmitted: false,
              sending: false,
              dirty: false,
            })
            return
          case 'code':
            // Generated code targets the active environment the same way a
            // send does, so a copied snippet runs against what was sent.
            setCodeFor({ ...item.request, url: withEnv(item.request.url) })
            return
          case 'curl':
            return copied(buildCurl(item.request))
          case 'response':
            return copied(item.response?.body ?? '')
        }
      })
      .catch(error => setNotice(errorText(error)))
  }

  // A duplicate is a fresh, unsaved tab: dropping nodeId keeps the original
  // untouched, so editing the copy never writes back over the stored request.
  const duplicateTab = (tab: Tab) => openTab({ name: tab.name, spec: { ...tab.spec } })

  // saveNode upserts the tab's request under parentId. An existing nodeId
  // keeps its identity (rename/move/update); a blank id creates a new node.
  const saveNode = (tab: Tab, name: string, parentId: string) => {
    const node = {
      id: tab.nodeId || '',
      parentId,
      type: 'request' as const,
      name,
      method: tab.spec.method,
      url: tab.spec.url,
      headers: tab.spec.headers,
      queryParams: tab.spec.queryParams,
      body: tab.spec.body,
      auth: tab.spec.auth,
      settings: tab.spec.settings,
    }
    invoke<{ items: CollectionNode[]; saved: CollectionNode }>('collection/save', { item: node })
      .then(result => {
        patchTab(tab.key, { dirty: false, nodeId: result.saved?.id || tab.nodeId, name })
        return reload()
      })
      .catch(error => setNotice(String((error as Error).message || error)))
  }

  const saveSpec = (tab: Tab) => {
    if (tab.nodeId) {
      // Already stored: update in place, keeping its group/folder.
      const current = nodes.find(node => node.id === tab.nodeId)
      saveNode(tab, current?.name || tab.name, current?.parentId || '')
      return
    }
    // Direct save into the quick-request group: no name prompt, the URL is the
    // name — so a request with no address has nothing to save under.
    const url = tab.spec.url?.trim()
    if (!url) {
      setNotice(t('urlRequired'))
      return
    }
    saveNode(tab, url, QUICK_ROOT_ID)
  }

  const createRequest = useCallback(() => {
    openTab({ name: t('newRequest'), spec: { method: 'GET', url: '' } })
  }, [t])

  const importCurlToTab = useCallback(() => {
    askText(
      t('importCurl'),
      '',
      command => {
        if (!command.trim()) return
        invoke<{ item: RequestSpec }>('curl/parse', { command })
          .then(r =>
            openTab({
              name: r.item.url || t('newRequest'),
              spec: r.item,
              // The panel opens on the body so the imported payload is visible
              // in the editor that matches it.
              revealBody: hasBody(r.item) ? 1 : undefined,
            })
          )
          .catch(error => setNotice(String((error as Error).message || error)))
      },
      { multiline: true, label: 'cURL', placeholder: t('importCurlHint') }
    )
  }, [t])

  // Copy a saved request as a cURL command straight from the tree.
  const copyNodeCurl = useCallback(
    (node: CollectionNode) => {
      const command = buildCurl({
        method: node.method || 'GET',
        url: node.url || '',
        headers: node.headers,
        queryParams: node.queryParams,
        body: node.body,
        auth: node.auth,
        settings: node.settings,
      })
      void copyText(command).then(ok => setNotice(ok ? t('copied') : t('copyFailed')))
    },
    [t]
  )

  // Workbench shortcuts, mirroring Apifox: ⌘↩ send, ⌘S save, ⌘T new request.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'Enter') {
        e.preventDefault()
        if (active && !active.sending) void send(active)
      } else if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (active) saveSpec(active)
      } else if (e.key.toLowerCase() === 't') {
        e.preventDefault()
        createRequest()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  if (host.error)
    return (
      <div className="boot" role="alert">
        {host.error}
      </div>
    )
  if (!host.connectionId)
    return (
      <div className="boot">
        <div className="boot-logo">
          <Icon name="api" size={44} />
        </div>
        <p>{t('connectFirst')}</p>
      </div>
    )

  return (
    <div
      className={sidebarWidth === 0 ? 'app sb-collapsed' : 'app'}
      style={
        {
          '--sb-width': `${sidebarWidth}px`,
          // The tree lays out at its own width and gets covered below it, so
          // its rows keep their shape while the editor's edge moves left.
          '--sb-floor': `${Math.max(sidebarWidth, DEFAULT_SIDEBAR_WIDTH)}px`,
        } as CSSProperties
      }
      onContextMenu={openContextMenu}
    >
      <div className="columns" ref={columnsRef}>
        <Sidebar
          t={t}
          nodes={nodes}
          history={history}
          activeNodeId={active?.nodeId}
          activeHistoryId={active?.historyId}
          onOpenRequest={node =>
            openTab({
              nodeId: node.id,
              name: node.name,
              spec: {
                method: node.method || 'GET',
                url: node.url || '',
                headers: node.headers,
                queryParams: node.queryParams,
                body: node.body,
                auth: node.auth,
                settings: node.settings,
              },
            })
          }
          onCreate={(parentId, type) =>
            askText(
              type === 'folder' ? t('newFolder') : t('newRequest'),
              '',
              name => {
                if (!name.trim()) return
                invoke<{ items: CollectionNode[] }>('collection/save', {
                  item: { parentId, type, name, method: 'GET', url: '' },
                })
                  .then(async r => {
                    await reload()
                    if (type === 'request') {
                      const created = r.items[r.items.length - 1]
                      if (created)
                        openTab({
                          nodeId: created.id,
                          name: created.name,
                          spec: { method: 'GET', url: '' },
                        })
                    }
                  })
                  .catch(error => setNotice(String((error as Error).message || error)))
              },
              { label: t('nameLabel'), placeholder: type === 'folder' ? t('newFolder') : t('newRequest') }
            )
          }
          onRename={node =>
            askText(t('rename'), node.name, name => {
              if (!name.trim()) return
              invoke('collection/save', { item: { ...node, name } })
                .then(reload)
                .catch(error => setNotice(String((error as Error).message || error)))
            }, { label: t('nameLabel') })
          }
          onDelete={node =>
            askConfirm(
              t('confirmDelete', { name: node.name }),
              () =>
                invoke('collection/delete', { id: node.id })
                  .then(reload)
                  .catch(error => setNotice(String((error as Error).message || error)))
            )
          }
          onOpenHistory={entry =>
            // The list only carries the request line; the recorded parameters
            // and response come with the entry when it is opened.
            invoke<{ item: HistoryRecord }>('history/get', { id: entry.id })
              .then(({ item }) => openTab(replayTab(item)))
              .catch(error => setNotice(errorText(error)))
          }
          onHistoryAction={historyAction}
          onClearHistory={() =>
            invoke('history/clear')
              .then(reload)
              .catch(error => setNotice(errorText(error)))
          }
          onImportCurl={importCurlToTab}
          onQuickRequest={createRequest}
          onCopyCurl={copyNodeCurl}
          onMoveNode={moveNode}
        />
        <div
          className="splitter v"
          role="separator"
          aria-orientation="vertical"
          aria-label={t('resizeSidebar')}
          onPointerDown={startSidebarDrag}
          onDoubleClick={resetSidebarWidth}
        />
        <main className="main" ref={mainRef}>
          <div
            className="tabbar"
            // Double-clicking the empty run of the bar starts a quick request,
            // the way a browser's tab strip opens a new tab. A double-click
            // that lands on a tab belongs to that tab, so it is left alone.
            onDoubleClick={e => {
              if ((e.target as HTMLElement).closest('.tab')) return
              createRequest()
            }}
          >
            {tabs.map(tab => (
              <button
                key={tab.key}
                className={`tab ${tab.key === activeKey ? 'active' : ''} ${tab.pinned ? 'pinned' : ''}`}
                onClick={() => setActiveKey(tab.key)}
                onContextMenu={e => {
                  e.preventDefault()
                  e.stopPropagation()
                  setActiveKey(tab.key)
                  setTabMenu({ x: e.clientX, y: e.clientY, tab })
                }}
                title={tab.name}
              >
                <span className="tab-name">
                  {tab.dirty ? '● ' : ''}
                  {tab.name}
                </span>
                {tab.pinned ? (
                  // The pin sits where the close control would be and is clicked
                  // the same way, so it has to do something: pressing it unpins.
                  // A pin that merely looks like a button reads as broken, and
                  // it is the shortest path back out of the pinned state.
                  <span
                    className="tab-pin"
                    role="button"
                    title={t('unpinTab')}
                    aria-label={t('unpinTab')}
                    onClick={e => {
                      e.stopPropagation()
                      togglePin(tab.key)
                    }}
                  >
                    <Icon name="pin" size={12} />
                  </span>
                ) : (
                  <span
                    className="tab-close"
                    role="button"
                    title={t('closeTab')}
                    aria-label={t('closeTab')}
                    onClick={e => {
                      e.stopPropagation()
                      closeTab(tab.key)
                    }}
                  >
                    ×
                  </span>
                )}
              </button>
            ))}
            <span className="spacer" />
            <span className="tab-hint">⌘↩ {t('send')} · ⌘S {t('save')} · ⌘T {t('newRequest')}</span>
          </div>
          {active ? (
            <>
              <div className="editor-wrap" style={{ height: editorHeight }}>
                <RequestPanel
                  t={t}
                  spec={active.spec}
                  sending={active.sending}
                  dirty={active.dirty}
                  revealBody={active.revealBody}
                  canSave={!!active.nodeId || !!active.spec.url?.trim()}
                  onChange={spec => patchTab(active.key, { spec, dirty: true })}
                  onSend={() => void send(active)}
                  onSave={() => saveSpec(active)}
                  onSaveAs={() => setSaveAsTab(active)}
                  onImportCurl={() =>
                    askText(
                      t('importCurl'),
                      '',
                      command => {
                        if (!command.trim()) return
                        invoke<{ item: RequestSpec }>('curl/parse', { command })
                          .then(r =>
                            patchTab(active.key, {
                              spec: r.item,
                              dirty: true,
                              name: r.item.url || active.name,
                              revealBody: hasBody(r.item)
                                ? (active.revealBody ?? 0) + 1
                                : active.revealBody,
                            })
                          )
                          .catch(error => setNotice(String((error as Error).message || error)))
                      },
                      { multiline: true, label: 'cURL', placeholder: t('importCurlHint') }
                    )
                  }
                  onGenerateCode={() => setCodeFor({ ...active.spec, url: withEnv(active.spec.url) })}
                  onEnvConfig={openEnvConfig}
                  activeEnvName={activeEnv?.name || ''}
                />
              </div>
              <div
                className="splitter"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t('resizeEditor')}
                onPointerDown={startEditorDrag}
                onDoubleClick={resetEditorHeight}
              />
              <ResponsePanel
                t={t}
                response={active.response}
                sending={active.sending}
                bodyOmitted={active.bodyOmitted}
                collapsed={responseCollapsed}
                onToggleCollapse={toggleResponse}
                onClearCookies={() => {
                  invoke('cookie/clear', {}).then(
                    () => setNotice(t('cookiesCleared')),
                    error => setNotice(errorText(error))
                  )
                }}
              />
            </>
          ) : (
            <div className="welcome">
              <div className="boot-logo">
                <Icon name="api" size={44} />
              </div>
              <div className="welcome-actions">
                <button className="primary" onClick={createRequest}>
                  <Icon name="plus" size={14} /> {t('newRequest')}
                </button>
                <button className="ghost" onClick={importCurlToTab}>
                  <Icon name="code" size={14} /> {t('importCurl')}
                </button>
              </div>
              <span className="tab-hint">⌘↩ {t('send')} · ⌘S {t('save')} · ⌘T {t('newRequest')}</span>
            </div>
          )}
        </main>
      </div>
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="ghost" title={t('close')} onClick={() => setNotice('')}>
            ×
          </button>
        </div>
      )}
      <TooltipLayer tooltip={tooltip} />
      {fieldMenu}
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          onClose={() => setTabMenu(null)}
          items={[
            {
              label: tabMenu.tab.pinned ? t('unpinTab') : t('pinTab'),
              icon: <Icon name="pin" size={14} />,
              onSelect: () => togglePin(tabMenu.tab.key),
            },
            {
              label: t('closeTab'),
              icon: <Icon name="close" size={14} />,
              // A pinned tab cannot be closed, so the entry is shown as
              // unavailable rather than silently doing nothing.
              disabled: tabMenu.tab.pinned,
              divider: true,
              onSelect: () => closeTab(tabMenu.tab.key),
            },
            {
              label: t('closeOtherTabs'),
              icon: <Icon name="close-others" size={14} />,
              disabled: tabs.length < 2,
              onSelect: () => closeTabs(tabMenu.tab.key),
            },
            {
              label: t('closeAllTabs'),
              icon: <Icon name="trash" size={14} />,
              disabled: tabs.length < 2,
              onSelect: () => closeTabs(),
            },
            {
              label: t('reloadTab'),
              icon: <Icon name="refresh" size={14} />,
              divider: true,
              disabled: !tabMenu.tab.spec.url?.trim(),
              onSelect: () => reloadTab(tabMenu.tab),
            },
            {
              label: t('duplicateTab'),
              icon: <Icon name="copy" size={14} />,
              onSelect: () => duplicateTab(tabMenu.tab),
            },
            {
              label: t('saveAs'),
              icon: <Icon name="folder" size={14} />,
              divider: true,
              onSelect: () => setSaveAsTab(tabMenu.tab),
            },
          ]}
        />
      )}
      {prompt && <Dialog prompt={prompt} onClose={close} />}
      {codeFor && <CodeDialog t={t} spec={codeFor} onClose={() => setCodeFor(null)} />}
      {envConfigOpen && (
        <EnvDialog
          t={t}
          environments={environments}
          activeId={activeEnvId}
          onChange={updateEnvironments}
          onActivate={activateEnv}
          onClose={() => setEnvConfigOpen(false)}
        />
      )}
      {saveAsTab && (
        <SaveAsDialog
          t={t}
          title={t('saveAs')}
          initialName={saveAsTab.spec.url?.trim() || saveAsTab.name || ''}
          folders={folderOptions}
          submitText={t('save')}
          onSubmit={(name, parentId) => saveNode(saveAsTab, name, parentId)}
          onClose={() => setSaveAsTab(null)}
        />
      )}
    </div>
  )
}
