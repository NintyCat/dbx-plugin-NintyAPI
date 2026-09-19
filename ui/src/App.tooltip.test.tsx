import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type Node = {
  id: string
  parentId: string
  type: 'request'
  name: string
  url: string
  method: string
}

function installBridge(nodes: Node[] = []) {
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      context: { connectionId: 'conn-1' },
      locale: 'zh-CN',
      theme: { appearance: 'light' },
      invoke: async (method: string) => {
        if (method === 'collection/list') return { items: nodes }
        if (method === 'history/list') return { items: [] }
        return {}
      },
      onContext: () => () => {},
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
  installBridge()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('tooltips', () => {
  it('shows a title quickly, ahead of the native tooltip delay', async () => {
    render(<App />)
    const button = await screen.findByRole('button', { name: '添加' })
    expect(button).toHaveAttribute('title', '添加')

    fireEvent.pointerOver(button)
    // Nothing before the short delay …
    expect(screen.queryByRole('tooltip')).toBeNull()
    vi.advanceTimersByTime(150)
    // … then ours is up, and the element's title is off so the browser does
    // not draw a second one.
    const tooltip = await screen.findByRole('tooltip')
    expect(tooltip).toHaveTextContent('添加')
    expect(button).not.toHaveAttribute('title')
    expect(tooltip.style.left).not.toBe('')
  })

  it('hides again and restores the title when the pointer leaves', async () => {
    render(<App />)
    const button = await screen.findByRole('button', { name: '添加' })
    fireEvent.pointerOver(button)
    vi.advanceTimersByTime(150)
    await screen.findByRole('tooltip')

    fireEvent.pointerOut(button, { relatedTarget: document.body })
    expect(screen.queryByRole('tooltip')).toBeNull()
    expect(button).toHaveAttribute('title', '添加')
  })

  it('keeps the tree rows free of hover tooltips', async () => {
    const url = 'https://api.example.com/v1/regulatoryApi/a/deeply/nested/path'
    installBridge([
      { id: 'n1', parentId: '__quick__', type: 'request', name: url, url, method: 'GET' },
      { id: 'n2', parentId: '__quick__', type: 'request', name: '登录', url: 'https://api.example.com/login', method: 'POST' },
    ])
    render(<App />)
    // The list shows no hover tooltips at all — not even where the row clips
    // a long name or a url the name does not spell out.
    expect(await screen.findByText('登录')).not.toHaveAttribute('title')
    expect((await screen.findByText(url)).closest('.tree-row')).not.toHaveAttribute('title')
  })

  it('does not blink when the pointer moves inside the same button', async () => {
    render(<App />)
    const button = await screen.findByRole('button', { name: '添加' })
    fireEvent.pointerOver(button)
    vi.advanceTimersByTime(150)
    const tooltip = await screen.findByRole('tooltip')

    // The icon inside the button is the same hover target.
    fireEvent.pointerOut(button, { relatedTarget: button.firstElementChild })
    expect(tooltip).toBeInTheDocument()
  })
})
