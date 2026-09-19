export type KV = {
  key: string
  value: string
  enabled?: boolean
}

export type BodySpec = {
  type: 'none' | 'json' | 'xml' | 'raw' | 'form' | 'multipart' | 'binary'
  content?: string
  fields?: KV[]
}

export type AuthSpec = {
  type: 'none' | 'bearer' | 'basic'
  token?: string
  username?: string
  password?: string
}

export type Settings = {
  followRedirects?: boolean
  verifyTLS?: boolean
  timeoutMs?: number
}

export type RequestSpec = {
  method: string
  url: string
  headers?: KV[]
  queryParams?: KV[]
  body?: BodySpec
  auth?: AuthSpec
  settings?: Settings
}

export type Timing = {
  dnsMs: number
  connectMs: number
  tlsMs: number
  firstByteMs: number
  downloadMs: number
}

export type RedirectStep = { status: number; location: string }

/** One cookie the request carried, and whether the connection's store brought it. */
export type SentCookie = {
  name: string
  value: string
  from: 'jar' | 'header'
}

export type Response = {
  status: number
  statusText: string
  proto: string
  headers: KV[]
  contentType: string
  body: string
  bodyBinary: boolean
  truncated: boolean
  sizeBytes: number
  timeMs: number
  timing: Timing
  url: string
  redirects?: RedirectStep[]
  cookies?: SentCookie[]
  error?: string
}

export type CollectionNode = {
  id: string
  parentId?: string
  type: 'folder' | 'request'
  name: string
  method?: string
  url?: string
  headers?: KV[]
  queryParams?: KV[]
  body?: BodySpec
  auth?: AuthSpec
  settings?: Settings
  description?: string
  /** Position among siblings; absent (0) on nodes never explicitly ordered. */
  order?: number
  createdAt: string
  updatedAt: string
}

/** One row in the history list: the recorded request line and outcome. */
export type HistorySummary = {
  id: string
  method: string
  url: string
  status: number
  timeMs: number
  error?: string
  createdAt: string
  /** The stored response body was cut to fit the history file. */
  responseBodyOmitted?: boolean
}

/** A whole recorded exchange, loaded when a history row is opened. */
export type HistoryRecord = {
  id: string
  createdAt: string
  request: RequestSpec
  response?: Response
  requestBodyOmitted?: boolean
  responseBodyOmitted?: boolean
}

export const METHODS = [
  'GET',
  'POST',
  'PUT',
  'DELETE',
  'PATCH',
  'HEAD',
  'OPTIONS',
] as const

export function emptySpec(): RequestSpec {
  return { method: 'GET', url: '' }
}
