import type { Lang } from './i18n'

/** One named base URL the request editor can target. */
export type Environment = {
  id: string
  name: string
  baseUrl: string
}

/** Storage keys, following the dbx-nintyapi: prefix the UI preferences use. */
const LIST_KEY = 'dbx-nintyapi:environments'
const ACTIVE_KEY = 'dbx-nintyapi:activeEnv'

let envSeq = 0
export const newEnvId = () => `env${++envSeq}-${Date.now()}`

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null /* private mode */
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

export function loadEnvironments(): Environment[] {
  try {
    const raw = readStorage(LIST_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(e => e && typeof e === 'object' && typeof e.id === 'string')
      .map(e => ({
        id: e.id,
        name: typeof e.name === 'string' ? e.name : '',
        baseUrl: typeof e.baseUrl === 'string' ? e.baseUrl : '',
      }))
  } catch {
    return [] /* corrupt JSON: start over rather than stay broken */
  }
}

export function saveEnvironments(list: Environment[]) {
  writeStorage(LIST_KEY, JSON.stringify(list))
}

export function loadActiveEnvId(): string {
  return readStorage(ACTIVE_KEY) || ''
}

export function saveActiveEnvId(id: string) {
  writeStorage(ACTIVE_KEY, id)
}

/**
 * The three starter environments, in the UI's language. Seeded the first time
 * the config dialog opens — by then the host locale is known, so the names
 * read like the rest of the UI.
 */
export function presetEnvironments(lang: Lang): Environment[] {
  const names: Record<Lang, [string, string, string]> = {
    zh: ['开发环境', '测试环境', '生产环境'],
    en: ['Development', 'Testing', 'Production'],
  }
  return names[lang].map(name => ({ id: newEnvId(), name, baseUrl: '' }))
}

/**
 * A URL for sending, with the active environment's base URL folded in.
 * `{{baseURL}}` is replaced wherever it appears; a relative path (no scheme)
 * is appended to the base. An absolute URL — with or without the token —
 * already names its host and is left alone.
 */
export function resolveUrl(baseUrl: string | undefined, url: string): string {
  const base = (baseUrl || '').trim()
  const target = (url || '').trim()
  if (!base || !target) return target
  const withToken = target.replaceAll('{{baseURL}}', base)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withToken) || withToken.startsWith('//'))
    return withToken
  const root = base.replace(/\/+$/, '')
  return withToken.startsWith('/') ? root + withToken : `${root}/${withToken}`
}
