import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { RequestSpec } from './lib/types'

/** Answer every call App makes on load; `parsed` is what curl/parse returns. */
function installBridge(parsed: RequestSpec) {
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
        if (method === 'curl/parse') return { item: parsed }
        return {}
      },
      onContext: () => () => {},
    },
  })
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

async function importCurl() {
  await userEvent.click(await screen.findByRole('button', { name: /导入 cURL/ }))
  const command = await screen.findByPlaceholderText('粘贴 cURL 命令，回车导入')
  await userEvent.type(command, 'curl -d ok https://api.example.com/x')
  await userEvent.click(screen.getByRole('button', { name: '确定' }))
}

describe('cURL import', () => {
  it('opens the body editor showing the imported payload in its format', async () => {
    installBridge({
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'xml', content: '<user><name>张三</name></user>' },
    })
    render(<App />)
    await importCurl()
    // The body tab is the visible one, with the XML payload in its editor.
    const bodyTab = await screen.findByRole('button', { name: '请求体' })
    expect(bodyTab).toHaveClass('active')
    expect(screen.getByDisplayValue('<user><name>张三</name></user>')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'XML' })).toHaveClass('active')
  })

  it('still lands on params when the imported command has no body', async () => {
    installBridge({ method: 'GET', url: 'https://api.example.com/x' })
    render(<App />)
    await importCurl()
    expect(await screen.findByRole('button', { name: /参数/ })).toHaveClass('active')
  })
})
