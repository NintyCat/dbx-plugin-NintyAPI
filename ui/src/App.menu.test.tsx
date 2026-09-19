import { fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
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

describe('right-click', () => {
  it('never reaches the native menu where the plugin has nothing to offer', async () => {
    render(<App />)
    const app = (await screen.findByPlaceholderText('搜索接口')).closest('.app') as HTMLElement
    // fireEvent returns false when the event's default was prevented.
    expect(fireEvent.contextMenu(app)).toBe(false)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('still opens the field menu on a text field', async () => {
    render(<App />)
    const search = await screen.findByPlaceholderText('搜索接口')
    expect(fireEvent.contextMenu(search)).toBe(false)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: '粘贴' })).toBeInTheDocument()
  })
})

describe('stacking order', () => {
  // jsdom lays nothing out and computes no stacking, so this reads the sheet and
  // checks the ranking itself. The contract it guards: a dialog can host a text
  // field, so its field menu has to paint above the dialog's backdrop — ranked
  // below it, the menu renders but the backdrop swallows it. A tooltip can be
  // raised from a control inside a dialog and needs the same standing.
  // Vitest runs with the ui/ directory as its root, so the sheet is a plain
  // relative path from there.
  const css = readFileSync('src/index.css', 'utf8')

  /** The numeric value behind a `z-index: var(--name)` declaration. */
  const rank = (token: string) => {
    const decl = css.match(new RegExp(`--${token}:\\s*(\\d+)`))
    expect(decl, `--${token} is not declared`).not.toBeNull()
    return Number(decl![1])
  }

  it('ranks the field menu and tooltip above the dialog backdrop', () => {
    expect(rank('z-menu')).toBeGreaterThan(rank('z-dialog'))
    expect(rank('z-tooltip')).toBeGreaterThan(rank('z-dialog'))
  })

  it('keeps the toast above everything transient', () => {
    expect(rank('z-toast')).toBeGreaterThan(rank('z-menu'))
    expect(rank('z-toast')).toBeGreaterThan(rank('z-tooltip'))
  })

  it('keeps page popovers below the dialog', () => {
    // A dropdown belongs to the page, not to a dialog: it must stay under the
    // backdrop so an open dialog is never punctured by a stale list.
    expect(rank('z-pop')).toBeLessThan(rank('z-dialog'))
  })

  it('uses the tokens rather than loose numbers for the layers they name', () => {
    expect(css).toMatch(/\.ctx-menu\s*\{[^}]*z-index:\s*var\(--z-menu\)/)
    expect(css).toMatch(/\.dlg-backdrop\s*\{[^}]*z-index:\s*var\(--z-dialog\)/)
    expect(css).toMatch(/\.tooltip\s*\{[^}]*z-index:\s*var\(--z-tooltip\)/)
  })
})
