import { describe, expect, it } from 'vitest'
import { buildCurl } from './curl'
import type { CollectionNode, RequestSpec } from './types'

describe('buildCurl', () => {
  it('renders method, url, headers, auth and body', () => {
    const spec: RequestSpec = {
      method: 'POST',
      url: 'https://api.example.com/users',
      headers: [{ key: 'X-Trace', value: 'abc', enabled: true }],
      queryParams: [{ key: 'full', value: '1', enabled: true }],
      auth: { type: 'bearer', token: 'tk' },
      body: { type: 'json', content: '{"name":"张三"}' },
    }
    const command = buildCurl(spec)
    expect(command).toContain(`curl -X POST`)
    expect(command).toContain(`'https://api.example.com/users?full=1'`)
    expect(command).toContain(`-H 'X-Trace: abc'`)
    expect(command).toContain(`-H 'Authorization: Bearer tk'`)
    expect(command).toContain(`-d '{"name":"张三"}'`)
  })

  it('skips disabled rows and settings flags', () => {
    const spec: RequestSpec = {
      method: 'GET',
      url: 'https://api.example.com',
      queryParams: [{ key: 'off', value: 'x', enabled: false }],
      headers: [{ key: 'X-Drop', value: 'y', enabled: false }],
      settings: { verifyTLS: false, followRedirects: true, timeoutMs: 4000 },
    }
    const command = buildCurl(spec)
    expect(command).toContain('-k')
    expect(command).toContain('-L')
    expect(command).toContain('-m 4')
    expect(command).not.toContain('off=')
    expect(command).not.toContain('X-Drop')
  })
})

describe('tree helpers', () => {
  it('splits and joins url query', async () => {
    const { splitUrlQuery, joinUrlQuery } = await import('./tree')
    const split = splitUrlQuery('https://x.test/api?name=%E5%BC%A0%E4%B8%89&off=1')
    expect(split.base).toBe('https://x.test/api')
    expect(split.params).toEqual([
      { key: 'name', value: '张三', enabled: true },
      { key: 'off', value: '1', enabled: true },
    ])
    expect(joinUrlQuery(split.base, split.params)).toBe(
      'https://x.test/api?name=%E5%BC%A0%E4%B8%89&off=1'
    )
  })
})

describe('collection node shape', () => {
  it('keeps request nodes distinguishable from folders', () => {
    const folder: CollectionNode = {
      id: 'f1',
      type: 'folder',
      name: '目录',
      createdAt: '',
      updatedAt: '',
    }
    const request: CollectionNode = {
      id: 'r1',
      parentId: 'f1',
      type: 'request',
      name: '登录',
      method: 'POST',
      url: '/login',
      createdAt: '',
      updatedAt: '',
    }
    expect(folder.type).toBe('folder')
    expect(request.parentId).toBe('f1')
  })
})
