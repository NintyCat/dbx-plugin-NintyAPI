import { describe, expect, it } from 'vitest'
import { makeT } from './i18n'
import {
  describeFile,
  fileFor,
  forgetFile,
  rememberFile,
  resolveRequestFiles,
  stripFileTokens,
  uploadFile,
  UPLOAD_CHUNK_BYTES,
} from './uploads'
import type { RequestSpec } from './types'

const t = makeT('zh')

/** A file of `size` bytes whose every byte is its index, so order is checkable. */
function makeFile(size: number, name = 'payload.bin', type = 'application/octet-stream') {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = i % 256
  return new File([bytes], name, { type })
}

/** Records every RPC call and reassembles the chunks it was given. */
function recordingInvoke() {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const chunks = new Map<string, { offset: number; data: Uint8Array }[]>()
  const invoke = async <R,>(method: string, params: Record<string, unknown> = {}): Promise<R> => {
    calls.push({ method, params })
    if (method === 'upload/begin') return { uploadId: 'up-1', chunkBytes: 1 << 20 } as R
    if (method === 'upload/chunk') {
      const list = chunks.get(String(params.uploadId)) ?? []
      list.push({
        offset: Number(params.offset),
        data: Uint8Array.from(atob(String(params.data)), c => c.charCodeAt(0)),
      })
      chunks.set(String(params.uploadId), list)
    }
    return {} as R
  }
  return { invoke, calls, chunks }
}

/** The bytes the sidecar would have after reassembling the recorded chunks. */
function reassemble(chunks: { offset: number; data: Uint8Array }[] | undefined) {
  if (!chunks) return new Uint8Array()
  const sorted = [...chunks].sort((a, b) => a.offset - b.offset)
  const total = sorted.reduce((sum, c) => sum + c.data.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of sorted) {
    out.set(chunk.data, at)
    at += chunk.data.length
  }
  return out
}

describe('uploadFile', () => {
  it('sends the bytes in order and names the upload it created', async () => {
    const { invoke, calls, chunks } = recordingInvoke()
    const file = makeFile(UPLOAD_CHUNK_BYTES + 500)
    const ref = await uploadFile(file, invoke)

    expect(ref.id).toBe('up-1')
    expect(ref.name).toBe('payload.bin')
    expect(ref.contentType).toBe('application/octet-stream')
    expect(ref.size).toBe(UPLOAD_CHUNK_BYTES + 500)

    const chunkCalls = calls.filter(c => c.method === 'upload/chunk')
    expect(chunkCalls).toHaveLength(2)
    expect(chunkCalls[0].params.offset).toBe(0)
    expect(chunkCalls[1].params.offset).toBe(UPLOAD_CHUNK_BYTES)
    // The sidecar must receive exactly the file's bytes, in order.
    expect(Array.from(reassemble(chunks.get('up-1')))).toEqual(
      Array.from(new Uint8Array(await file.arrayBuffer()))
    )
  })

  it('keeps every chunk under the bridge parameter cap', async () => {
    const { invoke, calls } = recordingInvoke()
    await uploadFile(makeFile(UPLOAD_CHUNK_BYTES * 2 + 1), invoke)
    for (const call of calls.filter(c => c.method === 'upload/chunk')) {
      // Base64 inflates by a third; the bridge rejects anything over 2 MiB.
      expect(String(call.params.data).length).toBeLessThan(2 << 20)
    }
  })

  it('declares the file up front so an oversized one fails before any chunk', async () => {
    const { invoke, calls } = recordingInvoke()
    await uploadFile(makeFile(10), invoke)
    expect(calls[0]).toEqual({
      method: 'upload/begin',
      params: { name: 'payload.bin', contentType: 'application/octet-stream', size: 10 },
    })
  })

  it('sends nothing for an empty file but still names it', async () => {
    const { invoke, calls } = recordingInvoke()
    const ref = await uploadFile(makeFile(0), invoke)
    expect(ref.id).toBe('up-1')
    expect(calls.filter(c => c.method === 'upload/chunk')).toHaveLength(0)
  })

  it('reports progress as the chunks land', async () => {
    const { invoke } = recordingInvoke()
    const seen: number[] = []
    const size = UPLOAD_CHUNK_BYTES + 100
    await uploadFile(makeFile(size), invoke, sent => seen.push(sent))
    expect(seen).toEqual([UPLOAD_CHUNK_BYTES, size])
  })

  it('abandons the upload when a chunk fails', async () => {
    const calls: string[] = []
    const invoke = async <R,>(method: string): Promise<R> => {
      calls.push(method)
      if (method === 'upload/begin') return { uploadId: 'up-9' } as R
      if (method === 'upload/chunk') throw new Error('boom')
      return {} as R
    }
    await expect(uploadFile(makeFile(UPLOAD_CHUNK_BYTES + 1), invoke)).rejects.toThrow('boom')
    expect(calls).toContain('upload/abort')
  })
})

describe('resolveRequestFiles', () => {
  it('uploads a picked file and points the row at it', async () => {
    const { invoke, calls } = recordingInvoke()
    const token = rememberFile(makeFile(4, 'avatar.png', 'image/png'))
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: {
        type: 'multipart',
        fields: [
          { key: 'name', value: '张三', kind: 'text' },
          { key: 'avatar', kind: 'file', file: { token, name: 'avatar.png', size: 4 } },
        ],
      },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    const fields = out.body?.fields ?? []
    expect(fields[0]).toEqual({ key: 'name', value: '张三', kind: 'text' })
    expect(fields[1].files).toHaveLength(1)
    expect(fields[1].files?.[0].id).toBe('up-1')
    expect(fields[1].files?.[0].name).toBe('avatar.png')
    // The token is a session detail and must not travel.
    expect(fields[1].files?.[0].token).toBeUndefined()
    expect(calls.map(c => c.method)).toEqual(['upload/begin', 'upload/chunk'])
  })

  it('sends a path-backed row without uploading anything', async () => {
    const { invoke, calls } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: {
        type: 'multipart',
        fields: [{ key: 'f', kind: 'file', files: [{ path: '/tmp/a.png' }] }],
      },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    expect(out.body?.fields?.[0].files).toEqual([{ path: '/tmp/a.png' }])
    expect(calls).toHaveLength(0)
  })

  it('refuses a file row with nothing to send', async () => {
    const { invoke } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: { type: 'multipart', fields: [{ key: 'avatar', kind: 'file' }] },
    }
    await expect(resolveRequestFiles(spec, invoke, t)).rejects.toThrow(
      '请为「avatar」选择文件'
    )
  })

  it('does not demand a file for a row that is switched off', async () => {
    const { invoke, calls } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: {
        type: 'multipart',
        fields: [{ key: 'avatar', kind: 'file', enabled: false }],
      },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    expect(out.body?.fields?.[0].kind).toBe('file')
    expect(calls).toHaveLength(0)
  })

  it('normalises a hand-written "@path" into the file list the sender reads', async () => {
    const { invoke, calls } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: { type: 'multipart', fields: [{ key: 'f', value: '@/tmp/a.png' }] },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    // Same bytes on the wire as before, but expressed the one way the sender
    // has to understand.
    expect(out.body?.fields?.[0].files).toEqual([{ path: '/tmp/a.png' }])
    expect(out.body?.fields?.[0].value).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('uploads every file a single row holds', async () => {
    let next = 0
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    const invoke = async <R,>(method: string, params: Record<string, unknown> = {}): Promise<R> => {
      calls.push({ method, params })
      if (method === 'upload/begin') return { uploadId: `up-${++next}` } as R
      return {} as R
    }
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/upload',
      body: {
        type: 'multipart',
        fields: [{
          key: 'file',
          kind: 'file',
          files: [
            { token: rememberFile(makeFile(8, 'a.xlsx')), name: 'a.xlsx', size: 8 },
            { token: rememberFile(makeFile(8, 'b.xlsx')), name: 'b.xlsx', size: 8 },
          ],
        }],
      },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    const files = out.body?.fields?.[0].files ?? []
    // One row, two uploads, two parts under the same field name.
    expect(files.map(f => f.id)).toEqual(['up-1', 'up-2'])
    expect(files.map(f => f.name)).toEqual(['a.xlsx', 'b.xlsx'])
    expect(out.body?.fields?.[0].key).toBe('file')
    expect(calls.filter(c => c.method === 'upload/begin')).toHaveLength(2)
  })

  it('uploads a picked binary body', async () => {
    const { invoke } = recordingInvoke()
    const token = rememberFile(makeFile(3, 'blob.bin'))
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'binary', file: { token, name: 'blob.bin', size: 3 } },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    expect(out.body?.file?.id).toBe('up-1')
    expect(out.body?.file?.token).toBeUndefined()
  })

  it('refuses a binary body with no file and no path', async () => {
    const { invoke } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'binary', file: { name: 'gone.bin' } },
    }
    await expect(resolveRequestFiles(spec, invoke, t)).rejects.toThrow('请先选择二进制请求体的文件')
  })

  it('leaves a legacy binary body to the sidecar when it only has a path', async () => {
    const { invoke, calls } = recordingInvoke()
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/x',
      body: { type: 'binary', content: '/tmp/legacy.bin' },
    }
    const out = await resolveRequestFiles(spec, invoke, t)
    expect(out).toEqual(spec)
    expect(calls).toHaveLength(0)
  })

  it('reports progress across every file in the request', async () => {
    const { invoke } = recordingInvoke()
    const a = rememberFile(makeFile(UPLOAD_CHUNK_BYTES, 'a.bin'))
    const b = rememberFile(makeFile(UPLOAD_CHUNK_BYTES, 'b.bin'))
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/x',
      body: {
        type: 'multipart',
        fields: [
          { key: 'a', kind: 'file', file: { token: a } },
          { key: 'b', kind: 'file', file: { token: b } },
        ],
      },
    }
    const seen: Array<{ sent: number; total: number }> = []
    await resolveRequestFiles(spec, invoke, t, p => seen.push(p))
    expect(seen.at(-1)).toEqual({ sent: UPLOAD_CHUNK_BYTES * 2, total: UPLOAD_CHUNK_BYTES * 2 })
  })
})

describe('file registry', () => {
  it('hands back the file a token names and forgets it on request', () => {
    const token = rememberFile(makeFile(1, 'a.bin'))
    expect(fileFor(token)?.name).toBe('a.bin')
    forgetFile(token)
    expect(fileFor(token)).toBeUndefined()
  })

  it('describes a row by name, falling back to the path', () => {
    expect(describeFile({ name: 'a.png', path: '/tmp/a.png' })).toBe('a.png')
    expect(describeFile({ path: '/tmp/a.png' })).toBe('/tmp/a.png')
    expect(describeFile(undefined)).toBe('')
  })
})

describe('stripFileTokens', () => {
  it('drops the token and the upload id but keeps what the files were called', () => {
    const out = stripFileTokens({
      type: 'multipart',
      fields: [
        { key: 'a', kind: 'file', files: [{ token: 't1', id: 'up-1', name: 'a.png', size: 3 }] },
        { key: 'b', value: 'x', kind: 'text' },
      ],
    })
    expect(out?.fields?.[0].files).toEqual([{ name: 'a.png', size: 3 }])
    expect(out?.fields?.[1]).toEqual({ key: 'b', value: 'x', kind: 'text' })
  })

  it('keeps the names of files it can no longer reach, so the row still says what they were', () => {
    const out = stripFileTokens({
      type: 'multipart',
      fields: [{
        key: 'a',
        kind: 'file',
        files: [{ token: 't1', name: 'a.png' }, { token: 't2', name: 'b.png' }],
      }],
    })
    expect(out?.fields?.[0].files).toEqual([{ name: 'a.png' }, { name: 'b.png' }])
    expect(out?.fields?.[0].kind).toBe('file')
  })

  it('folds the single-file shape saved before a row could hold several', () => {
    const out = stripFileTokens({
      type: 'multipart',
      fields: [{ key: 'a', kind: 'file', file: { token: 't1', name: 'a.png' } }],
    })
    expect(out?.fields?.[0].file).toBeUndefined()
    expect(out?.fields?.[0].files).toEqual([{ name: 'a.png' }])
  })

  it('keeps a path, which still resolves on the machine running DBX', () => {
    const out = stripFileTokens({
      type: 'multipart',
      fields: [{ key: 'a', kind: 'file', files: [{ token: 't1', path: '/tmp/a.png' }] }],
    })
    expect(out?.fields?.[0].files).toEqual([{ path: '/tmp/a.png' }])
  })

  it('keeps the name of a binary body it can no longer reach', () => {
    const out = stripFileTokens({
      type: 'binary',
      file: { token: 't1', name: 'a.bin' },
    })
    expect(out?.file).toEqual({ name: 'a.bin' })
  })
})
