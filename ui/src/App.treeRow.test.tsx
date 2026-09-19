import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { CollectionNode } from './lib/types'

const nodes: CollectionNode[] = [
  { id: 'f1', type: 'folder', name: '用户模块' },
  { id: 'r1', parentId: 'f1', type: 'request', name: '获取用户列表', method: 'GET', url: 'https://api.example.com/users' },
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

/** The tree rows, each with its name and its action buttons. */
function rows() {
  return [...document.querySelectorAll('.row.tree-row')].map(row => ({
    name: row.querySelector('.row-name')?.textContent ?? '',
    buttons: [...row.querySelectorAll('.row-ops button')],
  }))
}

describe('a tree row’s actions', () => {
  it('offers one overflow button instead of a copy/rename/delete trio', async () => {
    render(<App />)
    await screen.findByText('获取用户列表')
    for (const row of rows()) {
      expect(row.buttons).toHaveLength(1)
      expect(row.buttons[0]).toHaveAccessibleName('更多操作')
    }
  })

  it('opens the same menu as the right-click, with the row’s own actions', async () => {
    render(<App />)
    await screen.findByText('获取用户列表')
    const request = rows().find(r => r.name === '获取用户列表')
    await userEvent.click(request!.buttons[0])
    const items = screen.getAllByRole('menuitem').map(i => i.textContent?.trim())
    expect(items).toEqual(['复制 cURL', '重命名', '删除'])
  })

  it('gives a folder the actions that apply to a folder', async () => {
    render(<App />)
    await screen.findByText('用户模块')
    const folder = rows().find(r => r.name === '用户模块')
    await userEvent.click(folder!.buttons[0])
    const items = screen.getAllByRole('menuitem').map(i => i.textContent?.trim())
    expect(items).toEqual(['新建请求', '重命名', '删除'])
  })

  it('runs the action the menu names', async () => {
    render(<App />)
    await screen.findByText('获取用户列表')
    const request = rows().find(r => r.name === '获取用户列表')
    await userEvent.click(request!.buttons[0])
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名' }))
    // The rename dialog opens on the row's current name.
    expect(await screen.findByDisplayValue('获取用户列表')).toBeInTheDocument()
    // And the menu is gone.
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument()
  })
})
