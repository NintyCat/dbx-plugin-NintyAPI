import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// jsdom has no PointerEvent of its own; the splitter only reads clientX.
if (!window.PointerEvent) {
  class TestPointerEvent extends MouseEvent {
    pointerId: number
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init)
      this.pointerId = init.pointerId ?? 0
    }
  }
  window.PointerEvent = TestPointerEvent as unknown as typeof PointerEvent
}

beforeEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      context: { connectionId: 'conn-1' },
      locale: 'zh-CN',
      theme: { appearance: 'light' },
      invoke: async (method: string) => {
        if (method === 'collection/list' || method === 'history/list') return { items: [] }
        // Enough of a response for the response pane to render its status row.
        if (method === 'http/request')
          return {
            status: 200, statusText: 'OK', proto: 'HTTP/1.1',
            headers: [{ key: 'Content-Type', value: 'text/plain' }],
            contentType: 'text/plain', body: 'ok', bodyBinary: false, truncated: false,
            sizeBytes: 2, timeMs: 5,
            timing: { dnsMs: 0, connectMs: 0, tlsMs: 0, firstByteMs: 5, downloadMs: 0 },
            url: 'https://api.example.com/x',
          }
        return {}
      },
      onContext: () => () => {},
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

const treeWidth = () =>
  document.querySelector<HTMLElement>('.app')?.style.getPropertyValue('--sb-width')

const treeFloor = () =>
  document.querySelector<HTMLElement>('.app')?.style.getPropertyValue('--sb-floor')

describe('pane splitters', () => {
  it('resizes the tree pane by dragging and resets on double-click', async () => {
    render(<App />)
    const splitter = await screen.findByRole('separator', { name: /侧栏宽度/ })
    expect(splitter).toHaveAttribute('aria-orientation', 'vertical')
    expect(treeWidth()).toBe('264px')

    fireEvent.pointerDown(splitter, { clientX: 264, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 224, pointerId: 1 })
    expect(treeWidth()).toBe('224px')
    fireEvent.pointerUp(window, { pointerId: 1 })

    // The width sticks past the gesture and a double-click restores the default.
    expect(localStorage.getItem('dbx-nintyapi:sidebarWidth')).toBe('224')
    fireEvent.doubleClick(splitter)
    expect(treeWidth()).toBe('264px')
  })

  it('covers the tree gradually instead of snapping it shut', async () => {
    render(<App />)
    const splitter = await screen.findByRole('separator', { name: /侧栏宽度/ })
    // Every intermediate width holds; the rows keep their layout and are
    // covered rather than squeezed.
    fireEvent.pointerDown(splitter, { clientX: 264, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 164, pointerId: 1 })
    expect(treeWidth()).toBe('164px')
    expect(treeFloor()).toBe('264px')
    fireEvent.pointerMove(window, { clientX: 40, pointerId: 1 })
    expect(treeWidth()).toBe('40px')
    expect(treeFloor()).toBe('264px')
    // All the way left: covered, and marked so the grip stays grabbable.
    fireEvent.pointerMove(window, { clientX: 0, pointerId: 1 })
    expect(treeWidth()).toBe('0px')
    expect(document.querySelector('.app')).toHaveClass('sb-collapsed')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('sticks the editor to its default height when dragged near it', async () => {
    localStorage.setItem('dbx-nintyapi:editorHeight', '500')
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    // A response puts the pane back to the stored height; an untouched request
    // would sit collapsed (that is covered below).
    await userEvent.type(await screen.findByLabelText('地址'), 'https://api.example.com/x')
    await userEvent.click(screen.getByRole('button', { name: /发送/ }))
    await screen.findByText(/200 OK/)
    const wrap = document.querySelector('.editor-wrap') as HTMLElement
    const strip = document.querySelector('.req-tabs') as HTMLElement
    const box = (top: number, bottom: number) => ({
      top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top,
      toJSON: () => ({}),
    })
    wrap.getBoundingClientRect = () => box(0, 500) as DOMRect
    strip.getBoundingClientRect = () => box(88, 88) as DOMRect
    ;(document.querySelector('.main') as HTMLElement).getBoundingClientRect = () =>
      ({ ...box(0, 900), width: 800, left: 0, right: 800, x: 0 }) as DOMRect

    const splitter = screen.getByRole('separator', { name: /编辑器高度/ })
    fireEvent.pointerDown(splitter, { clientY: 500, pointerId: 1 })
    // 302 sits on the edge of the 320 default's snap range, and the grip
    // reports the magnet while it holds.
    fireEvent.pointerMove(window, { clientY: 302, pointerId: 1 })
    expect(wrap.style.height).toBe('320px')
    expect(splitter).toHaveClass('snapped')
    // … one pixel further out it does not snap.
    fireEvent.pointerMove(window, { clientY: 301, pointerId: 1 })
    expect(wrap.style.height).toBe('301px')
    expect(splitter).not.toHaveClass('snapped')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('keeps the request line and tab strip out of the scrolling panel', async () => {
    // jsdom lays nothing out, so this guards the structure the pane's scrolling
    // depends on rather than its pixels: the frame — request line and tab strip
    // — has to sit outside .req-body, the one box that scrolls. Were the strip
    // moved inside it, a long header list would carry the tabs off the top.
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    const wrap = document.querySelector('.editor-wrap') as HTMLElement
    const frame = wrap.firstElementChild as HTMLElement
    const line = frame.querySelector(':scope > .req-line')
    const strip = frame.querySelector(':scope > .req-tabs')
    const body = frame.querySelector(':scope > .req-body') as HTMLElement
    expect(line).not.toBeNull()
    expect(strip).not.toBeNull()
    expect(body).not.toBeNull()
    expect(body.querySelector('.req-line')).toBeNull()
    expect(body.querySelector('.req-tabs')).toBeNull()
  })

  it('lets the response cover the request body down to the tab strip', async () => {
    render(<App />)
    // Open a request so the editor pane exists, then report the tab strip's
    // underline 88px below the pane's top — the floor the drag must respect.
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    const wrap = document.querySelector('.editor-wrap') as HTMLElement
    const strip = document.querySelector('.req-tabs') as HTMLElement
    if (!wrap || !strip) throw new Error('editor pane did not render')
    const box = (top: number, bottom: number) => ({
      top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top,
      toJSON: () => ({}),
    })
    wrap.getBoundingClientRect = () => box(0, 320) as DOMRect
    strip.getBoundingClientRect = () => box(88, 88) as DOMRect

    const splitter = screen.getByRole('separator', { name: /编辑器高度/ })
    fireEvent.pointerDown(splitter, { clientY: 320, pointerId: 1 })
    fireEvent.pointerMove(window, { clientY: 0, pointerId: 1 })
    expect(wrap.style.height).toBe('88px')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  /** Stub the panes so the collapse maths has real numbers to work from. */
  function stubPanels() {
    const wrap = document.querySelector('.editor-wrap') as HTMLElement
    const resp = document.querySelector('.resp') as HTMLElement
    const head = resp.firstElementChild as HTMLElement
    const strip = document.querySelector('.req-tabs') as HTMLElement
    const box = (top: number, bottom: number) =>
      ({
        top, bottom, height: bottom - top, left: 0, right: 0, width: 0, x: 0, y: top,
        toJSON: () => ({}),
      }) as DOMRect
    // jsdom does no layout, so the panes report the geometry they would have:
    // 320px of editor plus a response that takes whatever is left of 620px.
    const wrapHeight = () => Number.parseFloat(wrap.style.height) || 320
    wrap.getBoundingClientRect = () => box(38, 38 + wrapHeight())
    resp.getBoundingClientRect = () => box(372, 372 + Math.max(0, 620 - wrapHeight()))
    // The status row sits 10px into the pane (its padding) and is 32px tall.
    head.getBoundingClientRect = () => box(382, 414)
    resp.style.paddingTop = '10px'
    resp.style.paddingBottom = '14px'
    strip.getBoundingClientRect = () => box(88, 88)
    return { wrap, resp, head }
  }

  it('collapses the response down to its status row, not past it', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    // Collapsing keeps the status row, so there has to be a response to keep.
    await userEvent.type(await screen.findByLabelText('地址'), 'https://api.example.com/x')
    await userEvent.click(screen.getByRole('button', { name: /发送/ }))
    await screen.findByText(/200 OK/)
    const { wrap } = stubPanels()

    const splitter = screen.getByRole('separator', { name: /编辑器高度/ })
    fireEvent.pointerDown(splitter, { clientY: 320, pointerId: 1 })
    fireEvent.pointerMove(window, { clientY: 900, pointerId: 1 })
    // Editor 320 + response 300 − (status row 32 + its 10px top and 14px bottom
    // padding): the status line and its buttons stay, nothing else.
    expect(wrap.style.height).toBe('564px')
    const resp = document.querySelector('.resp') as HTMLElement
    expect(resp).toHaveClass('collapsed')
    // Dragging back up brings the content out again.
    fireEvent.pointerMove(window, { clientY: 200, pointerId: 1 })
    expect(resp).not.toHaveClass('collapsed')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('toggles the response between collapsed and its previous height', async () => {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    // Send once so the response pane has a status row (and its toggle button).
    await userEvent.type(await screen.findByLabelText('地址'), 'https://api.example.com/x')
    await userEvent.click(screen.getByRole('button', { name: /发送/ }))
    await screen.findByText(/200 OK/)
    const { wrap } = stubPanels()
    wrap.style.height = '320px'

    const collapse = await screen.findByRole('button', { name: '收起到状态行' })
    await userEvent.click(collapse)
    expect(wrap.style.height).toBe('564px')
    // The button flips to the way back, which restores what the pane had.
    const restore = await screen.findByRole('button', { name: '还原高度' })
    await userEvent.click(restore)
    expect(wrap.style.height).toBe('320px')
  })

  it('keeps the stored height while the request has no response yet', async () => {
    localStorage.setItem('dbx-nintyapi:editorHeight', '500')
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
    const wrap = document.querySelector('.editor-wrap') as HTMLElement
    // An untouched request is not collapsed: the pane keeps its height and
    // shows the hint where the response will appear.
    expect(wrap.style.height).toBe('500px')
    expect(document.querySelector('.resp')).not.toHaveClass('collapsed')
    expect(screen.getByText('点击「发送」查看响应')).toBeInTheDocument()
  })

  it('sticks the tree to its default width when dragged near it', async () => {
    localStorage.setItem('dbx-nintyapi:sidebarWidth', '400')
    render(<App />)
    const splitter = await screen.findByRole('separator', { name: /侧栏宽度/ })
    fireEvent.pointerDown(splitter, { clientX: 400, pointerId: 1 })
    // 246 sits on the edge of the 264 default's snap range …
    fireEvent.pointerMove(window, { clientX: 246, pointerId: 1 })
    expect(treeWidth()).toBe('264px')
    expect(splitter).toHaveClass('snapped')
    // … one pixel further out it does not snap.
    fireEvent.pointerMove(window, { clientX: 245, pointerId: 1 })
    expect(treeWidth()).toBe('245px')
    expect(splitter).not.toHaveClass('snapped')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('stops the tree at its widest instead of filling the pane', async () => {
    render(<App />)
    const splitter = await screen.findByRole('separator', { name: /侧栏宽度/ })
    fireEvent.pointerDown(splitter, { clientX: 264, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 5000, pointerId: 1 })
    expect(treeWidth()).toBe('640px')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })

  it('leaves the editor 320px when the pane itself is the limit', async () => {
    render(<App />)
    const splitter = await screen.findByRole('separator', { name: /侧栏宽度/ })
    const columns = document.querySelector('.columns') as HTMLElement
    columns.getBoundingClientRect = () => ({
      width: 800, height: 600, top: 0, bottom: 600, left: 0, right: 800, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect
    fireEvent.pointerDown(splitter, { clientX: 264, pointerId: 1 })
    fireEvent.pointerMove(window, { clientX: 5000, pointerId: 1 })
    expect(treeWidth()).toBe('480px')
    fireEvent.pointerUp(window, { pointerId: 1 })
  })
})
