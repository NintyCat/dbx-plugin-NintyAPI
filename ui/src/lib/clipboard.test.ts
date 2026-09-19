import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText, readText } from './clipboard'

type PluginStub = {
  ready: Promise<void>
  invoke: (method: string, params: unknown, options?: { timeoutMs: number }) => Promise<unknown>
  copy?: (text: string) => Promise<unknown>
}

function installHost(stub: Partial<PluginStub>) {
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      invoke: vi.fn().mockRejectedValue(new Error('backend unavailable')),
      ...stub,
    } satisfies PluginStub,
  })
}

function installWeb(clipboard: { writeText?: unknown; readText?: unknown } | undefined) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    writable: true,
    value: clipboard,
  })
}

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  installWeb(undefined)
  vi.restoreAllMocks()
})

describe('copyText', () => {
  it('prefers the host bridge clipboard writer', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    const writeText = vi.fn().mockResolvedValue(undefined)
    installHost({ copy })
    installWeb({ writeText })
    expect(await copyText('abc')).toBe(true)
    expect(copy).toHaveBeenCalledWith('abc')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('falls back to the web API when the host offers no writer', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    installHost({})
    installWeb({ writeText })
    expect(await copyText('abc')).toBe(true)
    expect(writeText).toHaveBeenCalledWith('abc')
  })

  it('copies through a scratch textarea when the web API is denied', async () => {
    const execCommand = vi.fn().mockReturnValue(true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    installHost({})
    installWeb({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await copyText('abc')).toBe(true)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(document.querySelector('textarea')).toBeNull()
  })

  it('writes through the sidecar when nothing else can', async () => {
    const execCommand = vi.fn().mockReturnValue(false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand })
    const invoke = vi.fn().mockResolvedValue({ success: true })
    installHost({ invoke })
    installWeb({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await copyText('abc')).toBe(true)
    expect(invoke).toHaveBeenCalledWith('clipboard/write-text', { text: 'abc' }, expect.anything())
  })

  it('reports failure when every layer fails', async () => {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    })
    installHost({ copy: vi.fn().mockRejectedValue(new Error('nope')) })
    installWeb({ writeText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await copyText('abc')).toBe(false)
  })
})

describe('readText', () => {
  it('reads the clipboard through the sidecar when the web API is denied', async () => {
    const invoke = vi.fn().mockResolvedValue({ text: '来自剪贴板' })
    installHost({ invoke })
    installWeb({ readText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await readText()).toBe('来自剪贴板')
    expect(invoke).toHaveBeenCalledWith('clipboard/read-text', {}, expect.anything())
  })

  it('prefers the web API when it answers', async () => {
    const invoke = vi.fn()
    installHost({ invoke })
    installWeb({ readText: vi.fn().mockResolvedValue('web') })
    expect(await readText()).toBe('web')
    expect(invoke).not.toHaveBeenCalled()
  })

  it('treats a clipboard holding no text as empty', async () => {
    installHost({ invoke: vi.fn().mockResolvedValue({ text: '' }) })
    installWeb({ readText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await readText()).toBe('')
  })

  it('returns null when no layer can read', async () => {
    installHost({})
    installWeb({ readText: vi.fn().mockRejectedValue(new Error('denied')) })
    expect(await readText()).toBeNull()
  })
})
