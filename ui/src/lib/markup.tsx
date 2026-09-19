import type { ReactNode } from 'react'

/**
 * Markup pretty-printer for the response pane. It re-indents the document and
 * highlights it, which is the job JSON.stringify does for JSON: minified
 * responses arrive as one very long line, and rendering them as plain text is
 * no easier to read than the base64 it replaced.
 */

/** Elements with no closing tag; they must not deepen the indent. */
const voidTags = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
  'param', 'source', 'track', 'wbr',
])

/** Elements whose body is text, not markup. Indenting it would rewrite it. */
const rawTags = new Set(['script', 'style', 'textarea', 'pre'])

/** Elements that stay on the line they share with their text. */
const inlineTags = new Set([
  'a', 'abbr', 'area', 'b', 'bdi', 'bdo', 'big', 'br', 'button', 'caption',
  'cite', 'code', 'data', 'del', 'dfn', 'em', 'embed', 'font', 'i', 'img',
  'input', 'ins', 'kbd', 'label', 'legend', 'mark', 'nobr', 'option', 'q',
  'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub',
  'summary', 'sup', 'time', 'title', 'tt', 'u', 'var', 'wbr',
])

/**
 * Elements a browser closes by itself when the next sibling starts, so
 * `<li>a<li>b` reads as two items rather than one nested in the other.
 */
const optionalEndTags = new Set(['li', 'p', 'td', 'th', 'tr', 'dt', 'dd', 'option', 'optgroup', 'thead', 'tbody', 'tfoot', 'rt', 'rp'])

/** Longer than this and an inline element is broken like a block one. */
const flatWidth = 120

type Token =
  | { kind: 'open'; name: string; selfClosing: boolean; text: string }
  | { kind: 'close'; name: string; text: string }
  | { kind: 'comment'; text: string }
  | { kind: 'declaration'; text: string }
  | { kind: 'raw'; text: string }
  | { kind: 'text'; text: string }

type Node =
  | { kind: 'element'; name: string; open: string; close: string | null; children: Node[] }
  | { kind: 'text'; text: string }
  | { kind: 'raw'; text: string }
  | { kind: 'other'; text: string }

const tagStart = /^<\/?([A-Za-z][\w:.-]*)/

/** Walks to the '>' that ends a tag, ignoring one inside a quoted value. */
function tagEnd(source: string, from: number): number {
  let quote = ''
  for (let i = from; i < source.length; i++) {
    const ch = source[i]
    if (quote) {
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (ch === '>') {
      return i + 1
    }
  }
  return source.length
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  let text = ''
  const flush = () => {
    if (text) {
      tokens.push({ kind: 'text', text })
      text = ''
    }
  }
  while (index < source.length) {
    const lt = source.indexOf('<', index)
    if (lt === -1) {
      text += source.slice(index)
      break
    }
    if (lt > index) text += source.slice(index, lt)
    const rest = source.slice(lt)
    if (rest.startsWith('<!--')) {
      const end = source.indexOf('-->', lt + 4)
      const stop = end === -1 ? source.length : end + 3
      flush()
      tokens.push({ kind: 'comment', text: source.slice(lt, stop) })
      index = stop
      continue
    }
    if (rest.startsWith('<!') || rest.startsWith('<?')) {
      const stop = tagEnd(source, lt)
      flush()
      tokens.push({ kind: 'declaration', text: source.slice(lt, stop) })
      index = stop
      continue
    }
    const match = tagStart.exec(rest)
    if (!match) {
      // A bare '<' in text, as in "a < b".
      text += '<'
      index = lt + 1
      continue
    }
    const name = match[1]
    const stop = tagEnd(source, lt)
    const body = source.slice(lt, stop)
    if (rest.startsWith('</')) {
      flush()
      tokens.push({ kind: 'close', name, text: body })
      index = stop
      continue
    }
    const selfClosing = body.endsWith('/>')
    flush()
    tokens.push({ kind: 'open', name, selfClosing, text: body })
    index = stop
    if (selfClosing || !rawTags.has(name.toLowerCase())) continue
    const closer = new RegExp(`</${name}\\s*>`, 'i').exec(source.slice(index))
    const bodyEnd = closer ? index + closer.index : source.length
    if (bodyEnd > index) tokens.push({ kind: 'raw', text: source.slice(index, bodyEnd) })
    index = bodyEnd
  }
  flush()
  return tokens
}

function nest(tokens: Token[]): Node[] {
  const root: Node[] = []
  const open: Extract<Node, { kind: 'element' }>[] = []
  const current = () => (open.length ? open[open.length - 1].children : root)
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
      case 'raw':
        current().push({ kind: token.kind, text: token.text })
        break
      case 'comment':
      case 'declaration':
        current().push({ kind: 'other', text: token.text })
        break
      case 'open': {
        const name = token.name.toLowerCase()
        if (optionalEndTags.has(name) && open.length && open[open.length - 1].name === name) open.pop()
        const node = { kind: 'element' as const, name, open: token.text, close: null, children: [] as Node[] }
        current().push(node)
        if (!token.selfClosing && !voidTags.has(name)) open.push(node)
        break
      }
      case 'close': {
        const name = token.name.toLowerCase()
        const at = open.map(node => node.name).lastIndexOf(name)
        if (at === -1) {
          // A stray closing tag is kept as plain text rather than dropping it.
          current().push({ kind: 'other', text: token.text })
          break
        }
        open[at].close = token.text
        open.length = at
        break
      }
    }
  }
  return root
}

/**
 * Renders a subtree on one line, or returns null when it holds something that
 * has to break: a block element, a script body, or any other element that is
 * a container rather than a run of text.
 */
function flatten(node: Node): string | null {
  if (node.kind !== 'element') return null
  const parts: string[] = [node.open]
  let pieces = 0
  let pending = false
  let broke = false
  // Whitespace between two pieces can only mean one space, and never opens the
  // run: `<span>\n  hello\n</span>` is `<span>hello</span>`.
  const space = () => {
    if (pending && pieces > 0) parts.push(' ')
  }
  const walk = (child: Node) => {
    if (broke) return
    if (child.kind === 'raw' || (child.kind === 'element' && !inlineTags.has(child.name))) {
      broke = true
      return
    }
    if (child.kind === 'other') {
      space()
      pending = false
      parts.push(child.text)
      pieces++
      return
    }
    if (child.kind === 'text') {
      const collapsed = child.text.replace(/\s+/g, ' ')
      const body = collapsed.trim()
      if (!body) {
        pending = true
        return
      }
      if (pending || collapsed.startsWith(' ')) space()
      pending = collapsed.endsWith(' ')
      parts.push(body)
      pieces++
      return
    }
    space()
    pending = false
    parts.push(child.open)
    child.children.forEach(walk)
    if (child.close) parts.push(child.close)
    pieces++
  }
  node.children.forEach(walk)
  if (node.close) parts.push(node.close)
  return broke ? null : parts.join('')
}

/**
 * An element carrying text of its own is a run — a paragraph, a table cell, a
 * list item — and reads better on one line than spread over three. A container
 * like `<div><a>x</a></div>` keeps its structure instead.
 */
function isTextRun(node: Extract<Node, { kind: 'element' }>): boolean {
  return node.children.some(child => child.kind === 'text' && child.text.trim() !== '')
}

function render(nodes: Node[], depth: number, lines: string[]): void {
  for (const node of nodes) {
    const indent = '  '.repeat(depth)
    if (node.kind === 'text') {
      const text = node.text.replace(/\s+/g, ' ').trim()
      if (text) lines.push(indent + text)
      continue
    }
    if (node.kind === 'raw' || node.kind === 'other') {
      lines.push(indent + node.text)
      continue
    }
    const empty = node.children.every(child => child.kind === 'text' && !child.text.trim())
    if (empty && node.close) {
      lines.push(indent + node.open + node.close)
      continue
    }
    const oneLine = inlineTags.has(node.name) || isTextRun(node) ? flatten(node) : null
    if (oneLine !== null && (node.close === null || oneLine.length <= flatWidth)) {
      lines.push(indent + oneLine)
      continue
    }
    lines.push(indent + node.open)
    render(node.children, depth + 1, lines)
    if (node.close) lines.push(indent + node.close)
  }
}

/** True when the body opens with a tag, as opposed to prose or a data format. */
export function looksLikeMarkup(text: string): boolean {
  return /^<[!?/]?[A-Za-z][^>]*>/.test(text.slice(0, 512).replace(/^[\s\uFEFF]+/, ''))
}

export function tryFormatMarkup(text: string): { pretty: string; ok: boolean } {
  if (!looksLikeMarkup(text)) return { pretty: text, ok: false }
  const lines: string[] = []
  render(nest(tokenize(text)), 0, lines)
  const pretty = lines.join('\n')
  return { pretty, ok: pretty !== '' }
}

/** Lightweight markup highlighter that returns safe React nodes. */
export function highlightMarkup(text: string): ReactNode[] {
  const out: ReactNode[] = []
  let key = 0
  const emit = (chunk: string, cls?: string) => {
    if (!chunk) return
    out.push(cls ? <span key={key++} className={cls}>{chunk}</span> : chunk)
  }
  const emitTag = (tag: string) => {
    const parts = /^(<\/?)([A-Za-z][\w:.-]*)([\s\S]*)$/.exec(tag)
    if (!parts) {
      emit(tag)
      return
    }
    emit(parts[1])
    emit(parts[2], 'mtag')
    let rest = parts[3]
    const tail = /(\/?>)$/.exec(rest)
    if (tail) rest = rest.slice(0, rest.length - tail[1].length)
    const attr = /([^\s=/]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)?/g
    let last = 0
    let found: RegExpExecArray | null
    while ((found = attr.exec(rest))) {
      emit(rest.slice(last, found.index))
      emit(found[1], 'mattr')
      emit(found[2])
      emit(found[3] ?? '', 'mval')
      last = found.index + found[0].length
    }
    emit(rest.slice(last))
    if (tail) emit(tail[1])
  }
  for (const token of tokenize(text)) {
    switch (token.kind) {
      case 'comment':
        emit(token.text, 'mcmt')
        break
      case 'declaration':
        emit(token.text, 'mdoctype')
        break
      case 'open':
      case 'close':
        emitTag(token.text)
        break
      default:
        emit(token.text)
    }
  }
  return out
}
