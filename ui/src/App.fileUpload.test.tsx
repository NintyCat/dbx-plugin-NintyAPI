import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import type { RequestSpec, Response } from './lib/types'

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

function installBridge(overrides: Record<string, unknown> = {}) {
  const calls: Call[] = []
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
        if (method in overrides) return overrides[method]
        if (method === 'collection/list' || method === 'history/list') return { items: [] }
        return {}
      },
      onContext: () => () => {},
    },
  })
  return calls
}

function makeFile(size: number, name: string, type: string) {
  return new File([new Uint8Array(size)], name, { type })
}

/** An open request tab with a multipart body holding one file row. */
async function openMultipartWithAFile(file: File) {
  await openMultipartWithFiles([file])
}

/** An open request tab with a multipart body holding one file row. */
async function openMultipartWithFiles(files: File[]) {
  render(<App />)
  await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
  await userEvent.type(screen.getByLabelText('地址'), 'https://api.example.com/upload')
  await userEvent.click(screen.getByRole('button', { name: '请求体' }))
  await userEvent.click(screen.getByRole('button', { name: 'form-data' }))
  await userEvent.click(screen.getByRole('button', { name: /添加一行/ }))
  await userEvent.type(screen.getByLabelText('名称'), 'file')
  await userEvent.selectOptions(screen.getByLabelText('类型'), '文件')
  await userEvent.click(screen.getByRole('button', { name: '选择文件' }))
  fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
    target: { files },
  })
}

const lastCall = (calls: Call[], method: string) =>
  [...calls].reverse().find(call => call.method === method)

beforeEach(() => localStorage.clear())

afterEach(() => {
  Reflect.deleteProperty(window, 'dbxPlugin')
  vi.restoreAllMocks()
})

describe('sending a request with a picked file', () => {
  it('uploads the file before the request that uses it', async () => {
    const calls = installBridge({
      'http/request': okResponse,
      'upload/begin': { uploadId: 'up-1', chunkBytes: 512 * 1024 },
    })
    await openMultipartWithAFile(makeFile(700 * 1024, 'avatar.png', 'image/png'))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    await waitFor(() => expect(lastCall(calls, 'http/request')).toBeDefined())
    const order = calls.map(call => call.method)
    expect(order.indexOf('upload/begin')).toBeGreaterThan(-1)
    expect(order.indexOf('upload/begin')).toBeLessThan(order.indexOf('http/request'))
    // 700 KiB crosses the 512 KiB chunk boundary, so two chunks travel.
    expect(order.filter(m => m === 'upload/chunk')).toHaveLength(2)

    const sent = lastCall(calls, 'http/request')?.params as unknown as RequestSpec
    const field = sent.body?.fields?.[0]
    expect(field?.key).toBe('file')
    expect(field?.kind).toBe('file')
    expect(field?.files).toHaveLength(1)
    expect(field?.files?.[0].id).toBe('up-1')
    expect(field?.files?.[0].name).toBe('avatar.png')
    // The session-only token must never reach the sidecar.
    expect(field?.files?.[0].token).toBeUndefined()
  })

  it('says the upload is going while the bytes travel', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    installBridge({
      'http/request': okResponse,
      'upload/begin': { uploadId: 'up-1' },
      'upload/chunk': gate,
    })
    await openMultipartWithAFile(makeFile(1024, 'avatar.png', 'image/png'))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(await screen.findByRole('button', { name: /上传中/ })).toBeDisabled()
    release?.()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled()
    )
  })

  it('uploads every file when several are picked at once', async () => {
    let next = 0
    const calls = installBridge({ 'http/request': okResponse })
    // A fresh upload id per file, the way the sidecar mints them.
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
          if (method === 'upload/begin') return { uploadId: `up-${++next}` }
          if (method === 'http/request') return okResponse
          if (method === 'collection/list' || method === 'history/list') return { items: [] }
          return {}
        },
        onContext: () => () => {},
      },
    })

    await openMultipartWithFiles([
      makeFile(1024, 'a.xlsx'),
      makeFile(2048, 'b.xlsx'),
      makeFile(3072, 'c.xlsx'),
    ])
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(lastCall(calls, 'http/request')).toBeDefined())

    expect(calls.filter(c => c.method === 'upload/begin')).toHaveLength(3)
    expect(calls.filter(c => c.method === 'upload/chunk')).toHaveLength(3)

    const sent = lastCall(calls, 'http/request')?.params as unknown as RequestSpec
    const fields = sent.body?.fields ?? []
    // One field holding all three files; the sidecar turns that into three
    // parts sharing the name, which is what a browser sends for a multiple
    // file input.
    expect(fields).toHaveLength(1)
    expect(fields[0].key).toBe('file')
    expect(fields[0].files?.map(f => f.name)).toEqual(['a.xlsx', 'b.xlsx', 'c.xlsx'])
    expect(fields[0].files?.map(f => f.id)).toEqual(['up-1', 'up-2', 'up-3'])
  })

  it('refuses to send a file row whose file was never picked', async () => {    const calls = installBridge({ 'http/request': okResponse })
    render(<App />)
    await userEvent.click(await screen.findByRole('button', { name: '新建请求' }))
    await userEvent.type(screen.getByLabelText('地址'), 'https://api.example.com/upload')
    await userEvent.click(screen.getByRole('button', { name: '请求体' }))
    await userEvent.click(screen.getByRole('button', { name: 'form-data' }))
    await userEvent.click(screen.getByRole('button', { name: /添加一行/ }))
    await userEvent.type(screen.getByLabelText('名称'), 'avatar')
    await userEvent.selectOptions(screen.getByLabelText('类型'), '文件')
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    // The request must not go out with an empty part, and the reason is shown.
    expect(await screen.findByText('请为「avatar」选择文件')).toBeInTheDocument()
    expect(lastCall(calls, 'http/request')).toBeUndefined()
    expect(lastCall(calls, 'upload/begin')).toBeUndefined()
  })

  it('saves the filename but not the session token', async () => {
    const calls = installBridge({ 'http/request': okResponse, 'upload/begin': { uploadId: 'up-1' } })
    await openMultipartWithAFile(makeFile(1024, 'avatar.png', 'image/png'))
    await userEvent.click(screen.getByRole('button', { name: '保存为接口' }))
    // The request editor labels its form-field key "名称" too, so the dialog is
    // scoped rather than searched globally.
    const dialog = await screen.findByRole('dialog')
    await userEvent.clear(within(dialog).getByLabelText('名称'))
    await userEvent.type(within(dialog).getByLabelText('名称'), '上传头像')
    await userEvent.click(within(dialog).getByRole('button', { name: '保存' }))

    await waitFor(() => expect(lastCall(calls, 'collection/save')).toBeDefined())
    const item = (lastCall(calls, 'collection/save')?.params as { item: { body: RequestSpec['body'] } })
      .item
    const field = item.body?.fields?.[0]
    expect(field?.files?.map(f => f.name)).toEqual(['avatar.png'])
    expect(field?.files?.[0].token).toBeUndefined()
    expect(field?.files?.[0].id).toBeUndefined()
  })
})

// Moving a body from form-data to urlencoded and back must not cost the user
// their files — the encoding cannot send them, but the spec keeps them.
describe('switching encoding with files attached', () => {
  it('keeps the files across a switch to urlencoded and back', async () => {
    installBridge({ 'http/request': okResponse, 'upload/begin': { uploadId: 'up-1' } })
    await openMultipartWithAFile(makeFile(1024, 'avatar.png', 'image/png'))

    await userEvent.click(screen.getByRole('button', { name: 'x-www-form-urlencoded' }))
    // The row still says what it holds, and warns that this encoding cannot
    // carry it.
    expect(screen.getByText('1 个文件不会发送')).toBeInTheDocument()
    expect(screen.getByText(/此编码无法携带文件/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'form-data' }))
    expect(screen.getByText('avatar.png')).toBeInTheDocument()
  })

  it('does not lose the files when a text row is edited in urlencoded', async () => {
    const calls = installBridge({ 'http/request': okResponse, 'upload/begin': { uploadId: 'up-1' } })
    await openMultipartWithAFile(makeFile(1024, 'avatar.png', 'image/png'))
    await userEvent.click(screen.getByRole('button', { name: 'x-www-form-urlencoded' }))

    // Editing the file row's value is what used to erase its files for good.
    await userEvent.type(screen.getByLabelText('值'), 'x')
    await userEvent.click(screen.getByRole('button', { name: 'form-data' }))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(lastCall(calls, 'http/request')).toBeDefined())

    const sent = lastCall(calls, 'http/request')?.params as unknown as RequestSpec
    expect(sent.body?.fields?.[0].files?.[0].id).toBe('up-1')
  })

  it('refuses to send, rather than dropping the files silently', async () => {
    const calls = installBridge({ 'http/request': okResponse })
    await openMultipartWithAFile(makeFile(1024, 'avatar.png', 'image/png'))
    await userEvent.click(screen.getByRole('button', { name: 'x-www-form-urlencoded' }))
    await userEvent.click(screen.getByRole('button', { name: '发送' }))

    // The UI cannot honour this combination, so it says so instead of sending a
    // request whose file quietly vanished.
    expect(await screen.findByText(/请改用 form-data/)).toBeInTheDocument()
    expect(lastCall(calls, 'http/request')).toBeUndefined()
  })
})
