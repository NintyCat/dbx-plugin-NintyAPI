import { buildCurl } from './curl'
import type { RequestSpec } from './types'

export type CodeLanguage = 'curl' | 'javascript' | 'python' | 'go'

export const CODE_LANGUAGES: Array<{ id: CodeLanguage; label: string }> = [
  { id: 'curl', label: 'cURL' },
  { id: 'javascript', label: 'JavaScript (fetch)' },
  { id: 'python', label: 'Python (requests)' },
  { id: 'go', label: 'Go (net/http)' },
]

function jsString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function pyString(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function goString(value: string): string {
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}

function effective(spec: RequestSpec): {
  method: string
  url: string
  headers: Array<{ key: string; value: string }>
  bodyContent: string
  bodyIsForm: boolean
} {
  const query = (spec.queryParams || [])
    .filter(p => p.enabled !== false && p.key)
    .map(p => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value)}`)
    .join('&')
  const url = query
    ? `${spec.url}${spec.url.includes('?') ? '&' : '?'}${query}`
    : spec.url
  const headers: Array<{ key: string; value: string }> = []
  for (const h of spec.headers || []) {
    if (h.enabled === false || !h.key) continue
    if (h.key.toLowerCase() === 'authorization' && spec.auth && spec.auth.type !== 'none')
      continue
    headers.push({ key: h.key, value: h.value })
  }
  const auth = spec.auth
  if (auth?.type === 'bearer' && auth.token)
    headers.push({ key: 'Authorization', value: `Bearer ${auth.token}` })
  const body = spec.body
  let bodyContent = ''
  let bodyIsForm = false
  if (body && body.type !== 'none') {
    if (body.type === 'form' || body.type === 'multipart') {
      bodyIsForm = true
      const params = (body.fields || [])
        .filter(f => f.enabled !== false && f.key)
        .map(f => `${encodeURIComponent(f.key)}=${encodeURIComponent(f.value)}`)
      bodyContent = params.join('&')
      if (body.type === 'form')
        headers.push({ key: 'Content-Type', value: 'application/x-www-form-urlencoded' })
    } else if (body.content) {
      bodyContent = body.content
      const hasCT = headers.some(h => h.key.toLowerCase() === 'content-type')
      const ct =
        body.type === 'json'
          ? 'application/json'
          : body.type === 'xml'
            ? 'application/xml'
            : 'text/plain'
      if (!hasCT && body.type !== 'binary')
        headers.push({ key: 'Content-Type', value: ct })
    }
  }
  return { method: spec.method || 'GET', url, headers, bodyContent, bodyIsForm }
}

export function generateCode(spec: RequestSpec, language: CodeLanguage): string {
  if (language === 'curl') return buildCurl(spec)
  const { method, url, headers, bodyContent } = effective(spec)
  if (language === 'javascript') {
    const lines = [
      `const response = await fetch(${jsString(url)}, {`,
      `  method: ${jsString(method)},`,
    ]
    if (headers.length) {
      lines.push('  headers: {')
      for (const h of headers) lines.push(`    ${jsString(h.key)}: ${jsString(h.value)},`)
      lines.push('  },')
    }
    if (bodyContent && method !== 'GET' && method !== 'HEAD') {
      lines.push(`  body: ${jsString(bodyContent)},`)
    }
    lines.push('});')
    lines.push('console.log(response.status, await response.text());')
    return lines.join('\n')
  }
  if (language === 'python') {
    const lines = [`response = requests.${method.toLowerCase()}(`, `    ${pyString(url)},`]
    if (headers.length) {
      lines.push('    headers={')
      for (const h of headers) lines.push(`        ${pyString(h.key)}: ${pyString(h.value)},`)
      lines.push('    },')
    }
    if (bodyContent && method !== 'GET' && method !== 'HEAD') {
      lines.push(`    data=${pyString(bodyContent)},`)
    }
    lines.push(')')
    lines.push('print(response.status_code, response.text)')
    return lines.join('\n')
  }
  // go
  const lines = ['package main', '', 'import (', '\t"fmt"', '\t"io"', '\t"net/http"', ')', '']
  lines.push('func main() {')
  if (bodyContent && method !== 'GET' && method !== 'HEAD') {
    lines.push(`\tbody := strings.NewReader(${goString(bodyContent)})`)
    lines.push(`\treq, err := http.NewRequest(${goString(method)}, ${goString(url)}, body)`)
    lines.push('', '\t_ = io.EOF // keep io import for streamed bodies')
  } else {
    lines.push(`\treq, err := http.NewRequest(${goString(method)}, ${goString(url)}, nil)`)
  }
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  for (const h of headers) {
    lines.push(`\treq.Header.Set(${goString(h.key)}, ${goString(h.value)})`)
  }
  lines.push('\tresp, err := http.DefaultClient.Do(req)')
  lines.push('\tif err != nil {')
  lines.push('\t\tpanic(err)')
  lines.push('\t}')
  lines.push('\tdefer resp.Body.Close()')
  lines.push('\tbody, _ := io.ReadAll(resp.Body)')
  lines.push('\tfmt.Println(resp.Status, string(body))')
  lines.push('}')
  if (bodyContent && method !== 'GET' && method !== 'HEAD') {
    return lines
      .join('\n')
      .replace('import (', 'import (')
      .replace('\t"io"', '\t"io"\n\t"strings"')
      .replace('\t_ = io.EOF // keep io import for streamed bodies\n', '')
  }
  return lines.join('\n')
}
