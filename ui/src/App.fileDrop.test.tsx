import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { UPLOAD_CHUNK_BYTES } from './lib/uploads'
import type { RequestSpec } from './lib/types'

const okResponse: Response = {
  status: 200,
  statusText: 'OK',
  proto: 'HTTP/1.1',
  headers: [],
  contentType: 'application/json',
  body: '{"ok":true}',
  bodyBinary: false,
  truncated: false,
  sizeBytes: 11,
  timeMs: 12,
  timing: { dnsMs: 1, connectMs: 2, tlsMs: 3, firstByteMs: 4, downloadMs: 5 },
  url: 'https://api.example.com/upload',
}

type Call = { method: string; params: Record<string, unknown> }
type Handle = { handleId: string; name: string; size: number; contentType?: string }

/**
 * A host bridge that lends fileTransfer, the way the DBX desktop workbench
 * does: drops and drag hovers are routed through captured callbacks, and
 * read serves the bytes of one virtual file. The HTML5 routes a browser page
 * relies on never fire in that sandbox, so this file is the desktop story.
 */
function installBridgeWithFileTransfer(bytes: Uint8Array) {
  const calls: Call[] = []
  let drop: ((files: Handle[]) => void) | undefined
  let drag: ((active: boolean) => void) | undefined
  const cancelled: string[] = []
  Object.defineProperty(window, 'dbxPlugin', {
    configurable: true,
    writable: true,
    value: {
      ready: Promise.resolve(),
      context: { connectionId: 'conn-1' },
      locale: 'zh-CN',
      theme: { appearance: 'light' },
      invoke: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params })
        if (method === 'upload/begin') return { uploadId: 'up-1' }
        if (method === 'http/request') return okResponse
        if (method === 'collection/list' || method === 'history/list') return { items: [] }
        return {}
      },
      onContext: () => () => {},
      fileTransfer: {
        pick: async () => [],
        read: async (_id: string, offset: number, length?: number) => {
          const end = Math.min(offset + (length ?? UPLOAD_CHUNK_BYTES), bytes.length)
          const slice = bytes.subarray(offset, end)
          let binary = ''
          for (let i = 0; i < slice.length; i += 0x8000) {
            binary += String.fromCharCode(...slice.subarray(i, i + 0x8000))
          }
          return { dataBase64: btoa(binary), length: slice.length, eof: end >= bytes.length }
        },
        cancel: async (handleId: string) => {
          cancelled.push(handleId)
        },
        onDragState: (fn: (active: boolean) => void) => {
          drag = fn
          return () => {
            drag = undefined
          }
        },
        onDrop: (fn: (files: Handle[]) => void) => {
          drop = fn
          return () => {
            drop = undefined
          }
        },
      },
    },
  })
  return { calls, cancelled, drop: (files: Handle[]) => drop?.(files), drag: (active: boolean) => drag?.(active) }
}

const lastCall = (calls: Call[], method: string) =>
  [...calls].reverse().find(call => call.method === method)

beforeEach(() => localStorage.clear())

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

describe('host file drops', () => {
  it('turns a drop on an empty request into a form-data row and sends the bytes', async () => {
    const bytes = new Uint8Array(3000).map((_, i) => i % 251)
    const host = installBridgeWithFileTransfer(bytes)
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await userEvent.type(screen.getByLabelText('地址'), 'https://api.example.com/upload')

    host.drop([{ handleId: 'h-1', name: 'a.bin', size: bytes.length, contentType: 'application/octet-stream' }])

    // The row shows up with the dropped file's name, without anyone opening
    // the body tab by hand.
    expect(await screen.findByText('a.bin')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(lastCall(host.calls, 'http/request')).toBeDefined())

    expect(lastCall(host.calls, 'upload/begin')?.params).toMatchObject({
      name: 'a.bin',
      size: bytes.length,
    })
    // 3000 bytes ride one 512 KiB chunk, read from the host's handle.
    expect(host.calls.filter(c => c.method === 'upload/chunk')).toHaveLength(1)
    const chunk = lastCall(host.calls, 'upload/chunk')?.params as unknown as { offset: number; data: string }
    expect(chunk.offset).toBe(0)
    const sent = lastCall(host.calls, 'http/request')?.params as unknown as RequestSpec
    expect(sent.body?.type).toBe('multipart')
    expect(sent.body?.fields?.[0].files?.[0]).toMatchObject({ id: 'up-1', name: 'a.bin' })
    expect(sent.body?.fields?.[0].files?.[0].token).toBeUndefined()
  })

  it('appends further drops to the same row and releases handles when the row goes', async () => {
    const host = installBridgeWithFileTransfer(new Uint8Array(8))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))

    host.drop([{ handleId: 'h-1', name: 'one.bin', size: 8 }])
    expect(await screen.findByText('one.bin')).toBeInTheDocument()
    host.drop([{ handleId: 'h-2', name: 'two.bin', size: 8 }])
    expect(await screen.findByText('two.bin')).toBeInTheDocument()
    // Both drops landed in one row: the second appended instead of stacking.
    expect(screen.getByText('one.bin')).toBeInTheDocument()
    // Handles stay open across drops, so a send can re-read them.
    expect(host.cancelled).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: '移除该行' }))
    await waitFor(() => expect(host.cancelled).toEqual(['h-1', 'h-2']))
    expect(screen.queryByText('one.bin')).not.toBeInTheDocument()
  })

  it('fills the binary body with the first dropped file and says so', async () => {
    const host = installBridgeWithFileTransfer(new Uint8Array(8))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await userEvent.click(screen.getByRole('button', { name: '请求体' }))
    await userEvent.click(screen.getByRole('button', { name: 'binary' }))

    host.drop([
      { handleId: 'h-1', name: 'first.zip', size: 8 },
      { handleId: 'h-2', name: 'second.zip', size: 8 },
    ])

    expect(await screen.findByText('first.zip')).toBeInTheDocument()
    expect(screen.queryByText('second.zip')).not.toBeInTheDocument()
    expect(await screen.findByRole('status')).toHaveTextContent('binary 请求体只使用第一个文件')
  })

  it('refuses a drop onto a body that cannot carry files', async () => {
    const host = installBridgeWithFileTransfer(new Uint8Array(8))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await userEvent.click(screen.getByRole('button', { name: '请求体' }))
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }))

    host.drop([{ handleId: 'h-1', name: 'a.bin', size: 8 }])

    expect(await screen.findByRole('status')).toHaveTextContent('无法携带文件')
    expect(host.calls.filter(c => c.method === 'upload/begin')).toHaveLength(0)
  })

  it('shows the drop veil only while the drag hovers and the body can take files', async () => {
    const host = installBridgeWithFileTransfer(new Uint8Array(8))
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))

    host.drag(true)
    expect(await screen.findByText('松开以附加文件')).toBeInTheDocument()
    host.drag(false)
    await waitFor(() => expect(screen.queryByText('松开以附加文件')).not.toBeInTheDocument())

    // A body that cannot carry files gets no veil: the drop would only warn.
    await userEvent.click(screen.getByRole('button', { name: '请求体' }))
    await userEvent.click(screen.getByRole('button', { name: 'JSON' }))
    host.drag(true)
    await waitFor(() => expect(screen.queryByText('松开以附加文件')).not.toBeInTheDocument())
    host.drag(false)
  })
})
