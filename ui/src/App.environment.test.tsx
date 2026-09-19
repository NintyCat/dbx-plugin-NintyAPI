import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { Response } from './lib/types'

const okResponse: Response = {
  status: 200,
  statusText: 'OK',
  proto: 'HTTP/1.1',
  headers: [{ key: 'Content-Type', value: 'application/json' }],
  contentType: 'application/json',
  body: '{"ok":true}',
  bodyBinary: false,
  truncated: false,
  sizeBytes: 11,
  timeMs: 12,
  timing: { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, downloadMs: 5 },
  url: 'https://dev.example.com/users/1',
}

function installBridge(invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      context: { connectionId: 'conn-1' },
      locale: 'zh-CN',
      theme: { appearance: 'light' },
      invoke,
      onContext: () => () => {},
    },
  })
}

function bridgeStub(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  installBridge(async (method, params) => {
    calls.push({ method, params })
    if (method in overrides) return overrides[method]
    if (method === 'collection/list' || method === 'history/list') return { items: [] }
    return {}
  })
  return calls
}

/** A workbench with one open request tab whose URL is the given path. */
async function openRequest(url: string) {
  const calls = bridgeStub({ 'http/request': okResponse })
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
  await userEvent.type(screen.getByLabelText('地址'), url)
  return calls
}

/** Opens 环境配置, fills the first preset's base URL and activates it. */
async function useDevEnvironment(baseUrl: string) {
  await userEvent.click(screen.getByRole('button', { name: '环境配置' }))
  // First open seeds the three starter environments.
  expect(screen.getByDisplayValue('开发环境')).toBeInTheDocument()
  expect(screen.getByDisplayValue('测试环境')).toBeInTheDocument()
  expect(screen.getByDisplayValue('生产环境')).toBeInTheDocument()
  await userEvent.type(screen.getByLabelText('Base URL (开发环境)'), baseUrl)
  await userEvent.click(screen.getByRole('radio', { name: '使用此环境: 开发环境' }))
  await userEvent.click(screen.getByRole('button', { name: '关闭' }))
}

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

describe('environment config', () => {
  it('seeds the starter environments on first open and keeps edits', async () => {
    await openRequest('/users/1')
    await useDevEnvironment('https://dev.example.com')
    // The configuration outlives the dialog.
    expect(screen.getByRole('button', { name: '开发环境' })).toBeInTheDocument()
    const stored = JSON.parse(localStorage.getItem('dbx-nintyapi:environments') || '[]')
    expect(stored.map((env: { name: string }) => env.name)).toEqual([
      '开发环境',
      '测试环境',
      '生产环境',
    ])
    expect(stored[0].baseUrl).toBe('https://dev.example.com')
  })

  it('sends a relative URL against the activated environment', async () => {
    const calls = await openRequest('/users/1')
    await useDevEnvironment('https://dev.example.com')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/200 OK/)).toBeInTheDocument()
    const sent = calls.find(c => c.method === 'http/request')
    expect(sent?.params.url).toBe('https://dev.example.com/users/1')
  })

  it('leaves the URL alone while no environment is active', async () => {
    const calls = await openRequest('https://api.example.com/users/1')
    // Open the dialog and close it again without activating anything.
    await userEvent.click(screen.getByRole('button', { name: '环境配置' }))
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    expect(await screen.findByText(/200 OK/)).toBeInTheDocument()
    const sent = calls.find(c => c.method === 'http/request')
    expect(sent?.params.url).toBe('https://api.example.com/users/1')
  })

  it('folds the environment into generated code', async () => {
    await openRequest('/users/1')
    await useDevEnvironment('https://dev.example.com')
    await userEvent.click(screen.getByRole('button', { name: '生成代码' }))
    const code = document.querySelector('.dlg-code')?.textContent ?? ''
    expect(code).toContain('https://dev.example.com/users/1')
  })

  it('adds a custom environment and removes a preset', async () => {
    await openRequest('/users/1')
    await userEvent.click(screen.getByRole('button', { name: '环境配置' }))
    await userEvent.click(screen.getByRole('button', { name: '添加环境' }))
    const name = screen.getByDisplayValue('自定义环境')
    expect(name).toBeInTheDocument()
    await userEvent.clear(name)
    await userEvent.type(name, '预发环境')
    await userEvent.type(screen.getByLabelText('Base URL (预发环境)'), 'https://staging.example.com')
    await userEvent.click(screen.getByRole('radio', { name: '使用此环境: 预发环境' }))
    await userEvent.click(screen.getByRole('button', { name: '删除: 测试环境' }))
    expect(screen.queryByDisplayValue('测试环境')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    const stored = JSON.parse(localStorage.getItem('dbx-nintyapi:environments') || '[]')
    expect(stored.map((env: { name: string }) => env.name)).toEqual([
      '开发环境',
      '生产环境',
      '预发环境',
    ])
    expect(localStorage.getItem('dbx-nintyapi:activeEnv')).toBe(stored[2].id)
  })

  it('falls back to no environment and keeps that choice on reload', async () => {
    bridgeStub()
    const first = render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await useDevEnvironment('https://dev.example.com')
    await userEvent.click(screen.getByRole('button', { name: '开发环境' }))
    await userEvent.click(screen.getByRole('radio', { name: '无环境' }))
    await userEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.getByRole('button', { name: '环境配置' })).toBeInTheDocument()
    expect(localStorage.getItem('dbx-nintyapi:activeEnv')).toBe('')
    first.unmount()

    // The next session picks the stored list back up — without seeding a
    // second copy of the presets over the names the user changed.
    const stored = JSON.parse(localStorage.getItem('dbx-nintyapi:environments') || '[]')
    stored[0].name = '改过名的环境'
    localStorage.setItem('dbx-nintyapi:environments', JSON.stringify(stored))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await userEvent.click(screen.getByRole('button', { name: '环境配置' }))
    expect(screen.getByDisplayValue('改过名的环境')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: '无环境' })).toBeChecked()
  })

  it('restores the active environment name onto the tool button', async () => {
    localStorage.setItem(
      'dbx-nintyapi:environments',
      JSON.stringify([{ id: 'e1', name: '开发环境', baseUrl: 'https://dev.example.com' }])
    )
    localStorage.setItem('dbx-nintyapi:activeEnv', 'e1')
    bridgeStub()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    expect(screen.getByRole('button', { name: '开发环境' })).toBeInTheDocument()
  })
})
