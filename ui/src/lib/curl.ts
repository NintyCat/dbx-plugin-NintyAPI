import type { RequestSpec } from './types'

function quote(value: string): string {
  // Use single quotes and escape embedded ones, the way shells expect.
  return `'${value.replaceAll("'", `'\\''`)}'`
}

const skipHeadersOnCurl = new Set(['host', 'content-length'])

/**
 * buildCurl renders a request spec as a copyable cURL command. Variables are
 * left as {{name}} placeholders, matching what the UI shows.
 */
export function buildCurl(spec: RequestSpec): string {
  const parts = [`curl -X ${spec.method || 'GET'}`]
  let url = spec.url || ''
  const query = (spec.queryParams || [])
    .filter(p => p.enabled !== false && p.key)
    .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&')
  if (query) url += (url.includes('?') ? '&' : '?') + query
  if (url) parts.push(quote(url))
  for (const h of spec.headers || []) {
    if (h.enabled === false || !h.key) continue
    const name = h.key.toLowerCase()
    if (name === 'authorization' && spec.auth && spec.auth.type !== 'none')
      continue
    if (skipHeadersOnCurl.has(name)) continue
    parts.push(`-H ${quote(`${h.key}: ${h.value}`)}`)
  }
  const auth = spec.auth
  if (auth && auth.type === 'bearer' && auth.token)
    parts.push(`-H ${quote(`Authorization: Bearer ${auth.token}`)}`)
  if (auth && auth.type === 'basic')
    parts.push(
      `-u ${quote(`${auth.username || ''}:${auth.password || ''}`)}`
    )
  const body = spec.body
  if (body && body.type !== 'none') {
    if (body.type === 'form' || body.type === 'multipart') {
      for (const f of body.fields || []) {
        if (f.enabled === false || !f.key) continue
        parts.push(
          body.type === 'form'
            ? `-d ${quote(`${f.key}=${f.value}`)}`
            : `-F ${quote(`${f.key}=${f.value}`)}`
        )
      }
    } else if (body.content) {
      parts.push(`-d ${quote(body.content)}`)
    }
  }
  const settings = spec.settings
  if (settings?.verifyTLS === false) parts.push('-k')
  if (settings?.followRedirects) parts.push('-L')
  if (settings?.timeoutMs) parts.push(`-m ${Math.ceil(settings.timeoutMs / 1000)}`)
  return parts.join(' ')
}
