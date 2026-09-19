import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { CollectionNode } from './lib/types'

const nodes: CollectionNode[] = [
  { id: 'r1', type: 'request', name: '请求一', method: 'GET', url: 'https://api.example.com/1' },
  { id: 'r2', type: 'request', name: '请求二', method: 'GET', url: 'https://api.example.com/2' },
  { id: 'r3', type: 'request', name: '请求三', method: 'GET', url: 'https://api.example.com/3' },
]

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
        if (method === 'collection/list') return { items: nodes }
        if (method === 'history/list') return { items: [] }
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

const strip = () =>
  [...document.querySelectorAll('.tabbar .tab')].map(t => ({
    name: t.querySelector('.tab-name')?.textContent?.trim() ?? '',
    pinned: t.classList.contains('pinned'),
    hasClose: !!t.querySelector('.tab-close'),
    hasPin: !!t.querySelector('.tab-pin'),
  }))

const activeTabName = () =>
  document.querySelector('.tabbar .tab.active .tab-name')?.textContent?.trim()

/** Open every request in the tree, in order, so the strip is 一/二/三. */
async function openThree() {
  render(<App />)
  for (const name of ['请求一', '请求二', '请求三']) {
    const row = (await screen.findByText(name)).closest('.row') as HTMLElement
    await userEvent.click(row)
  }
  return strip()
}

/** Open a tab's context menu and pick an item. */
async function menuOn(name: string, item: string) {
  const tab = [...document.querySelectorAll('.tabbar .tab')].find(
    t => t.querySelector('.tab-name')?.textContent?.trim() === name
  ) as HTMLElement
  fireEvent.contextMenu(tab)
  await userEvent.click(await screen.findByRole('menuitem', { name: item }))
}

describe('pinned tabs', () => {
  it('moves a pinned tab to the front and marks it', async () => {
    expect((await openThree()).map(t => t.name)).toEqual(['请求一', '请求二', '请求三'])
    await menuOn('请求三', '固定标签页')
    expect(strip()).toEqual([
      { name: '请求三', pinned: true, hasClose: false, hasPin: true },
      { name: '请求一', pinned: false, hasClose: true, hasPin: false },
      { name: '请求二', pinned: false, hasClose: true, hasPin: false },
    ])
  })

  it('offers no close control on a pinned tab', async () => {
    await openThree()
    await menuOn('请求二', '固定标签页')
    const pinned = document.querySelector('.tabbar .tab.pinned') as HTMLElement
    // A disabled × that does nothing reads as broken, so it is not rendered.
    expect(pinned.querySelector('.tab-close')).toBeNull()
    expect(pinned.querySelector('.tab-pin')).not.toBeNull()
  })

  it('unpins when the pin itself is pressed', async () => {
    await openThree()
    await menuOn('请求二', '固定标签页')
    expect(strip()[0]).toEqual({ name: '请求二', pinned: true, hasClose: false, hasPin: true })
    // The pin sits where the close control does and looks pressable, so it has
    // to act: pressing it is the shortest way back out of the pinned state.
    const pin = document.querySelector('.tabbar .tab-pin') as HTMLElement
    expect(pin).toHaveAttribute('role', 'button')
    await userEvent.click(pin)
    expect(strip()[0]).toEqual({ name: '请求二', pinned: false, hasClose: true, hasPin: false })
  })

  it('does not bring the tab forward when its pin is pressed', async () => {
    await openThree()
    await menuOn('请求一', '固定标签页')
    // Focus a different tab, then unpin from the pin without stealing focus.
    await userEvent.click(document.querySelectorAll('.tabbar .tab')[1] as HTMLElement)
    expect(activeTabName()).toBe('请求二')
    await userEvent.click(document.querySelector('.tabbar .tab-pin') as HTMLElement)
    expect(activeTabName()).toBe('请求二')
  })

  it('refuses to close a pinned tab, however the close is asked for', async () => {
    await openThree()
    await menuOn('请求二', '固定标签页')
    expect(strip().map(t => t.name)).toEqual(['请求二', '请求一', '请求三'])

    // Through the menu: the entry is offered but unavailable.
    fireEvent.contextMenu(document.querySelector('.tabbar .tab.pinned') as HTMLElement)
    const close = await screen.findByRole('menuitem', { name: '关闭标签页' })
    expect(close).toBeDisabled()
    await userEvent.click(close)
    expect(strip().map(t => t.name)).toEqual(['请求二', '请求一', '请求三'])

    // And the menu now offers to unpin instead of pin.
    fireEvent.contextMenu(document.querySelector('.tabbar .tab.pinned') as HTMLElement)
    expect(await screen.findByRole('menuitem', { name: '取消固定' })).toBeInTheDocument()
  })

  it('keeps pinned tabs through close-others and close-all', async () => {
    await openThree()
    await menuOn('请求一', '固定标签页')

    await menuOn('请求三', '关闭其他标签页')
    // The pinned tab survives, alongside the one the menu was opened on.
    expect(strip().map(t => t.name)).toEqual(['请求一', '请求三'])

    await menuOn('请求三', '关闭全部标签页')
    expect(strip()).toEqual([
      { name: '请求一', pinned: true, hasClose: false, hasPin: true },
    ])
    // And it takes focus rather than dropping the user on the empty state.
    expect(document.querySelector('.welcome')).toBeNull()
    expect(document.querySelector('.tabbar .tab.active .tab-name')?.textContent?.trim()).toBe('请求一')
  })

  it('unpins back into the strip with its close control restored', async () => {
    await openThree()
    await menuOn('请求三', '固定标签页')
    expect(strip()[0]).toEqual({ name: '请求三', pinned: true, hasClose: false, hasPin: true })
    await menuOn('请求三', '取消固定')
    // It keeps its place in the strip; only the pin state changes.
    expect(strip()[0]).toEqual({ name: '请求三', pinned: false, hasClose: true, hasPin: false })
  })

  it('opens a new tab after the pinned run', async () => {
    await openThree()
    await menuOn('请求一', '固定标签页')
    expect(strip().map(t => t.name)).toEqual(['请求一', '请求二', '请求三'])
    // A fresh tab joins the unpinned run rather than jumping the pin.
    fireEvent.doubleClick(document.querySelector('.tabbar') as HTMLElement)
    expect(strip().map(t => t.name)).toEqual(['请求一', '请求二', '请求三', '新建请求'])
  })
})
