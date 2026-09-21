import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function installBridge() {
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
        return {}
      },
      onContext: () => () => {},
    },
  })
}

async function openBodyTab() {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
  await userEvent.click(screen.getByRole('button', { name: '请求体' }))
}

beforeEach(() => localStorage.clear())

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

describe('body type chips', () => {
  // The two form encodings differ in nothing but these words, so they have to
  // be the words the tools everyone comes from already use.
  it('names the types after their wire formats', async () => {
    installBridge()
    await openBodyTab()
    for (const label of [
      'none',
      'JSON',
      'XML',
      'raw',
      'x-www-form-urlencoded',
      'form-data',
      'binary',
    ]) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('shows the media type each one sends, so no name is a guess', async () => {
    installBridge()
    await openBodyTab()
    const mediaTypes: Record<string, string> = {
      JSON: 'application/json',
      XML: 'application/xml',
      raw: 'text/plain',
      'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
      'form-data': 'multipart/form-data',
      binary: 'application/octet-stream',
    }
    for (const [label, mediaType] of Object.entries(mediaTypes)) {
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('title', mediaType)
    }
    // Nothing is sent for `none`, so it claims no media type.
    expect(screen.getByRole('button', { name: 'none' })).not.toHaveAttribute('title')
  })

  // The labels are protocol names and stay in English in both locales; only the
  // surrounding chrome is translated.
  it('keeps the type names English in an English locale', async () => {
    installBridge()
    Object.defineProperty(window, 'dbxPlugin', {
      configurable: true,
      writable: true,
      value: {
        ready: Promise.resolve(),
        context: { connectionId: 'conn-1' },
        locale: 'en',
        theme: { appearance: 'light' },
        invoke: async (method: string) => {
          if (method === 'collection/list' || method === 'history/list') return { items: [] }
          return {}
        },
        onContext: () => () => {},
      },
    })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: 'New request' }))
    await userEvent.click(screen.getByRole('button', { name: 'Body' }))
    expect(screen.getByRole('button', { name: 'x-www-form-urlencoded' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'form-data' })).toBeInTheDocument()
  })
})
