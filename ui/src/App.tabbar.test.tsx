import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

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
      invoke: async (method: string) =>
        method === 'collection/list' || method === 'history/list' ? { items: [] } : {},
      onContext: () => () => {},
    },
  })
})

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

const tabNames = () =>
  [...document.querySelectorAll('.tabbar .tab-name')].map(n => n.textContent?.trim())
const activeTab = () =>
  document.querySelector('.tabbar .tab.active .tab-name')?.textContent?.trim()

/** Open one tab so the strip has a tab plus an empty run beside it. */
async function openOneTab() {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: /新建请求/ }))
  return document.querySelector('.tabbar') as HTMLElement
}

describe('the tab strip’s empty run', () => {
  it('starts a quick request on double-click', async () => {
    const bar = await openOneTab()
    expect(tabNames()).toHaveLength(1)
    // The empty run is the bar itself, past the last tab.
    fireEvent.doubleClick(bar)
    expect(tabNames()).toHaveLength(2)
    // The new request is the one in front, with an empty address to fill in.
    expect(activeTab()).toBe('新建请求')
    expect(screen.getByLabelText('地址')).toHaveValue('')
  })

  it('leaves a double-click on a tab to that tab', async () => {
    const bar = await openOneTab()
    fireEvent.doubleClick(bar)
    expect(tabNames()).toHaveLength(2)
    // Double-clicking an existing tab must not add another one.
    fireEvent.doubleClick(document.querySelector('.tabbar .tab')!)
    expect(tabNames()).toHaveLength(2)
    // It only brings that tab forward.
    expect(activeTab()).toBe(tabNames()[0])
  })

  it('does not add a request when the close button is double-clicked', async () => {
    const bar = await openOneTab()
    fireEvent.doubleClick(bar)
    expect(tabNames()).toHaveLength(2)
    // The close control lives inside a tab, so its double-click closes that tab
    // and must not also reach the bar's new-request handler. A real double-click
    // is the whole gesture — the clicks that close, then the dblclick.
    await userEvent.dblClick(document.querySelector('.tabbar .tab .tab-close')!)
    expect(tabNames()).toHaveLength(1)
  })
})
