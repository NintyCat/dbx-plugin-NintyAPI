import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { HistoryRecord, HistorySummary } from './lib/types'

const summary: HistorySummary = {
  id: 'h1',
  method: 'POST',
  url: 'https://api.example.com/users?page=2',
  status: 201,
  timeMs: 42,
  createdAt: new Date().toISOString(),
}

const record: HistoryRecord = {
  id: 'h1',
  createdAt: summary.createdAt,
  request: {
    method: 'POST',
    url: 'https://api.example.com/users',
    queryParams: [{ key: 'page', value: '2', enabled: true }],
    headers: [{ key: 'X-Trace', value: 'abc', enabled: true }],
    auth: { type: 'bearer', token: 'tk' },
    body: { type: 'json', content: '{"name":"张三"}' },
  },
  response: {
    status: 201,
    statusText: 'Created',
    proto: 'HTTP/1.1',
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    contentType: 'application/json',
    body: '{"id":1}',
    bodyBinary: false,
    truncated: false,
    sizeBytes: 8,
    timeMs: 42,
    timing: { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, downloadMs: 5 },
    url: 'https://api.example.com/users?page=2',
  },
}

function installBridge(invoke: (method: string, params: Record<string, unknown>) => Promise<unknown>) {
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      context: { connectionId: 'conn-1', connectionName: '演示 API' },
      locale: 'zh-CN',
      theme: { appearance: 'light' },
      invoke,
      onContext: () => () => {},
    },
  })
}

/** Answers the calls App makes on load, plus history/get for the replay. */
function bridgeStub(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  installBridge(async (method, params) => {
    calls.push({ method, params })
    if (method in overrides) return overrides[method]
    if (method === 'collection/list') return { items: [] }
    if (method === 'history/list') return { items: [summary] }
    if (method === 'history/get') return { item: record }
    return {}
  })
  return calls
}

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

describe('history pane', () => {
  it('lists a recorded request with its method, url, status and time', async () => {
    bridgeStub()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    const row = await screen.findByRole('button', { name: /POST/ })
    expect(within(row).getByText('https://api.example.com/users?page=2')).toBeInTheDocument()
    expect(within(row).getByText('201')).toBeInTheDocument()
    // Same-day entries read as a clock time, so seconds are always shown.
    expect(within(row).getByText(/\d{2}:\d{2}:\d{2}/)).toBeInTheDocument()
  })

  it('marks the entry it opened as the selected one', async () => {
    bridgeStub()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    const row = await screen.findByRole('button', { name: /POST/ })
    expect(row).not.toHaveClass('current')
    await userEvent.click(row)
    expect(await screen.findByRole('button', { name: /POST/ })).toHaveClass('current')
  })

  it('replays the recorded parameters and response when opened', async () => {
    const calls = bridgeStub()
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /POST/ }))
    expect(await screen.findByLabelText('地址')).toHaveValue(
      'https://api.example.com/users?page=2'
    )
    expect(calls.some(c => c.method === 'history/get' && c.params.id === 'h1')).toBe(true)
    // The response that came back with it, not an empty panel. The body is
    // syntax-highlighted, so compare its text rather than a single node.
    expect(await screen.findByText(/201 Created/)).toBeInTheDocument()
    const body = document.querySelector('.resp pre')?.textContent ?? ''
    expect(body.replace(/\s+/g, '')).toContain('"id":1')
    // Parameters, headers and body travel with the entry.
    expect(screen.getByRole('button', { name: /参数 · 1/ })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /请求头/ }))
    expect(await screen.findByDisplayValue('X-Trace')).toBeInTheDocument()
    expect(screen.getByDisplayValue('abc')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '请求体' }))
    expect(await screen.findByDisplayValue('{"name":"张三"}')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '认证' }))
    expect(await screen.findByDisplayValue('tk')).toBeInTheDocument()
  })
})

describe('history context menu', () => {
  async function openMenu() {
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    const row = await screen.findByRole('button', { name: /POST/ })
    fireEvent.contextMenu(row)
    return row
  }

  it('offers the actions that make a recorded request reusable', async () => {
    bridgeStub()
    await openMenu()
    const items = (await screen.findAllByRole('menuitem')).map(item => item.textContent)
    expect(items).toEqual([
      '重新发送',
      '保存为接口',
      '复制 cURL',
      '复制地址',
      '复制响应',
      '生成代码',
      '删除这条记录',
    ])
  })

  it('copies the recorded url without loading the entry', async () => {
    const calls = bridgeStub()
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: '复制地址' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(calls.some(c => c.method === 'clipboard/write-text' && c.params.text === summary.url)).toBe(true)
    expect(calls.some(c => c.method === 'history/get')).toBe(false)
  })

  it('sends the recorded request again from the menu', async () => {
    const response = { ...record.response, status: 200, statusText: 'OK', body: '{"ok":true}' }
    const calls = bridgeStub({ 'http/request': response })
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: '重新发送' }))
    expect(await screen.findByText(/200 OK/)).toBeInTheDocument()
    const sent = calls.find(c => c.method === 'http/request')
    expect(sent?.params).toMatchObject({
      method: 'POST',
      url: 'https://api.example.com/users?page=2',
      body: { type: 'json', content: '{"name":"张三"}' },
      auth: { type: 'bearer', token: 'tk' },
    })
  })

  it('copies the recorded response body', async () => {
    const calls = bridgeStub()
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: '复制响应' }))
    expect(await screen.findByText('已复制')).toBeInTheDocument()
    expect(calls.some(c => c.method === 'clipboard/write-text' && c.params.text === '{"id":1}')).toBe(true)
  })

  it('deletes a single entry and refreshes the list', async () => {
    const calls = bridgeStub()
    await openMenu()
    await userEvent.click(await screen.findByRole('menuitem', { name: '删除这条记录' }))
    await waitFor(() => {
      expect(calls.some(c => c.method === 'history/delete' && c.params.id === 'h1')).toBe(true)
    })
    expect(calls.filter(c => c.method === 'history/list').length).toBeGreaterThan(1)
  })
})

describe('markup responses', () => {
  // The label is the one a page arrives under when a server mis-types it, so
  // the pane has to read the body rather than the header.
  const page =
    '<!DOCTYPE html><html><head><title>示例</title></head><body><div id="wrapper">' +
    '<a href="/s?wd=x">搜索</a></div></body></html>'
  const markupRecord: HistoryRecord = {
    ...record,
    id: 'h2',
    request: { ...record.request, method: 'GET', url: 'https://www.example.com' },
    response: {
      ...record.response,
      status: 200,
      statusText: 'OK',
      contentType: 'application/x-gzip',
      body: page,
      url: 'https://www.example.com',
    },
  }

  it('formats and highlights a markup body instead of showing one long line', async () => {
    bridgeStub({
      'history/list': {
        items: [{ ...summary, id: 'h2', method: 'GET', status: 200, url: 'https://www.example.com' }],
      },
      'history/get': { item: markupRecord },
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /GET/ }))
    expect(await screen.findByText(/200 OK/)).toBeInTheDocument()
    const body = document.querySelector('.resp pre')
    expect(body?.textContent?.split('\n')).toEqual([
      '<!DOCTYPE html>',
      '<html>',
      '  <head>',
      '    <title>示例</title>',
      '  </head>',
      '  <body>',
      '    <div id="wrapper">',
      '      <a href="/s?wd=x">搜索</a>',
      '    </div>',
      '  </body>',
      '</html>',
    ])
    expect(body?.querySelector('.mtag')?.textContent).toBe('html')
    // The raw tab still shows exactly what arrived.
    await userEvent.click(screen.getByRole('button', { name: '原始' }))
    expect(document.querySelector('.resp pre')?.textContent).toBe(page)
  })
})

describe('replayed cookies', () => {
  const withCookies: HistoryRecord = {
    ...record,
    response: {
      ...record.response,
      cookies: [{ name: 'sid', value: 's1', from: 'jar' }],
    },
  }

  it('clears the stored cookies from the response pane', async () => {
    const calls = bridgeStub({ 'history/get': { item: withCookies } })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /POST/ }))
    await userEvent.click(await screen.findByRole('button', { name: 'Cookie · 1' }))
    expect(await screen.findByText('sid')).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('清除已保存的 Cookie'))
    await waitFor(() => {
      expect(calls.some(c => c.method === 'cookie/clear')).toBe(true)
    })
    expect(await screen.findByText('Cookie 已清除')).toBeInTheDocument()
  })
})
