import type { ReactNode } from 'react'

const tokenRe =
  /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/** Lightweight JSON syntax highlighter that returns safe React nodes. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  let i = 0
  tokenRe.lastIndex = 0
  while ((match = tokenRe.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index))
    let cls = 'jnum'
    if (match[1] !== undefined) cls = match[2] ? 'jkey' : 'jstr'
    else if (match[3] !== undefined) cls = 'jbool'
    out.push(
      <span key={i++} className={cls}>
        {match[0]}
      </span>
    )
    last = match.index + match[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function tryPretty(text: string): { pretty: string; ok: boolean } {
  try {
    return { pretty: JSON.stringify(JSON.parse(text), null, 2), ok: true }
  } catch {
    return { pretty: text, ok: false }
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
