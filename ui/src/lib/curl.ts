import { describeFile, isFileRow, rowFiles } from './uploads'
import type { FormField, RequestSpec } from './types'

function quote(value: string): string {
  // Use single quotes and escape embedded ones, the way shells expect.
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * A form row's values as curl spells them. A file row becomes one `-F name=@…`
 * per file — the shape curl uses for several files under one field, and the one
 * the importer folds back into a single row. The picked bytes are not in the
 * command, so a filename is the most a copied command can carry.
 */
function curlFields(field: FormField): string[] {
  const files = rowFiles(field)
  if (files.length > 0) {
    return files.map(file => {
      const name = describeFile(file)
      return `${field.key}=@${file.path || name}`
    })
  }
  // A file row with nothing attached contributes nothing, rather than an empty
  // field that curl would send as a successful upload of zero bytes.
  if (isFileRow(field)) return []
  return [`${field.key}=${field.value ?? ''}`]
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
        if (body.type === 'form') {
          parts.push(`-d ${quote(`${f.key}=${f.value ?? ''}`)}`)
          continue
        }
        for (const field of curlFields(f)) parts.push(`-F ${quote(field)}`)
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
