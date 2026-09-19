import { afterEach, describe, expect, it } from 'vitest'
import {
  loadActiveEnvId,
  loadEnvironments,
  presetEnvironments,
  resolveUrl,
  saveActiveEnvId,
  saveEnvironments,
} from './environments'

afterEach(() => {
  localStorage.clear()
})

describe('resolveUrl', () => {
  it('appends a relative path to the base URL', () => {
    expect(resolveUrl('https://dev.example.com', '/users/1')).toBe(
      'https://dev.example.com/users/1'
    )
  })

  it('keeps one slash between base and path', () => {
    expect(resolveUrl('https://dev.example.com/', '/users')).toBe(
      'https://dev.example.com/users'
    )
    expect(resolveUrl('https://dev.example.com', 'users')).toBe(
      'https://dev.example.com/users'
    )
  })

  it('leaves an absolute URL alone', () => {
    expect(resolveUrl('https://dev.example.com', 'https://prod.example.com/x')).toBe(
      'https://prod.example.com/x'
    )
    expect(resolveUrl('', '/users')).toBe('/users')
  })

  it('replaces the {{baseURL}} token wherever it sits', () => {
    expect(resolveUrl('https://dev.example.com', '{{baseURL}}/users')).toBe(
      'https://dev.example.com/users'
    )
    expect(resolveUrl('https://dev.example.com', 'https://proxy.io?up={{baseURL}}')).toBe(
      'https://proxy.io?up=https://dev.example.com'
    )
  })

  it('ignores an empty base or target', () => {
    expect(resolveUrl('https://dev.example.com', '')).toBe('')
    expect(resolveUrl('  ', '/users')).toBe('/users')
  })
})

describe('storage', () => {
  it('round-trips the environment list', () => {
    expect(loadEnvironments()).toEqual([])
    const list = presetEnvironments('zh')
    saveEnvironments(list)
    expect(loadEnvironments()).toEqual(list)
  })

  it('starts over on corrupt JSON instead of staying broken', () => {
    localStorage.setItem('dbx-nintyapi:environments', '{oops')
    expect(loadEnvironments()).toEqual([])
  })

  it('drops entries that are not environments', () => {
    localStorage.setItem(
      'dbx-nintyapi:environments',
      JSON.stringify([{ id: 'e1', name: '开发环境', baseUrl: 'https://dev' }, null, 42, {}])
    )
    expect(loadEnvironments()).toEqual([{ id: 'e1', name: '开发环境', baseUrl: 'https://dev' }])
  })

  it('round-trips the active environment id', () => {
    expect(loadActiveEnvId()).toBe('')
    saveActiveEnvId('e1')
    expect(loadActiveEnvId()).toBe('e1')
  })
})

describe('presetEnvironments', () => {
  it('seeds the three starter environments in the UI language', () => {
    expect(presetEnvironments('zh').map(env => env.name)).toEqual([
      '开发环境',
      '测试环境',
      '生产环境',
    ])
    expect(presetEnvironments('en').map(env => env.name)).toEqual([
      'Development',
      'Testing',
      'Production',
    ])
    const seeded = presetEnvironments('zh')
    expect(new Set(seeded.map(env => env.id)).size).toBe(3)
    expect(seeded.every(env => env.baseUrl === '')).toBe(true)
  })
})
