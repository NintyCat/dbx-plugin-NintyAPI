import { describe, expect, it } from 'vitest'
import { highlightMarkup, looksLikeMarkup, tryFormatMarkup } from './markup'

/** Flattens highlighted nodes back to text, to prove nothing was dropped. */
function textOf(nodes: unknown): string {
  if (typeof nodes === 'string') return nodes
  if (Array.isArray(nodes)) return nodes.map(textOf).join('')
  const element = nodes as { props?: { children?: unknown } }
  return element?.props ? textOf(element.props.children) : ''
}

const minified =
  '<!DOCTYPE html><html><head><meta http-equiv=Content-Type content="text/html;charset=utf-8">' +
  '<title>百度一下，你就知道</title></head><body><div id="wrapper"><a href="/s?wd=x">搜索</a></div></body></html>'

describe('formatting minified markup', () => {
  it('indents one tag per line and keeps the doctype on top', () => {
    const { pretty, ok } = tryFormatMarkup(minified)
    expect(ok).toBe(true)
    expect(pretty.split('\n')).toEqual([
      '<!DOCTYPE html>',
      '<html>',
      '  <head>',
      '    <meta http-equiv=Content-Type content="text/html;charset=utf-8">',
      '    <title>百度一下，你就知道</title>',
      '  </head>',
      '  <body>',
      '    <div id="wrapper">',
      '      <a href="/s?wd=x">搜索</a>',
      '    </div>',
      '  </body>',
      '</html>',
    ])
  })

  it('treats void elements as leaves', () => {
    const { pretty } = tryFormatMarkup('<div><br><img src="a.png"><hr></div>')
    expect(pretty.split('\n')).toEqual([
      '<div>',
      '  <br>',
      '  <img src="a.png">',
      '  <hr>',
      '</div>',
    ])
  })

  it('leaves the body of script and style alone', () => {
    const source = '<script>\nif (a < b) { go() }\n</script><style>a{color:red}</style>'
    const { pretty } = tryFormatMarkup(source)
    expect(pretty).toContain('if (a < b) { go() }')
    expect(pretty).toContain('a{color:red}')
    expect(pretty).not.toContain('&lt;')
  })

  it('does not split a tag on a > inside a quoted value', () => {
    const { pretty } = tryFormatMarkup('<a title="a > b"><span>x</span></a>')
    expect(pretty).toBe('<a title="a > b"><span>x</span></a>')
  })

  it('keeps inline elements on the line they share with their text', () => {
    const { pretty } = tryFormatMarkup('<p>请<b>注意</b>：<a href="/s">详情</a></p>')
    // The spaces the source had are kept; none are invented between characters.
    expect(pretty).toBe('<p>请<b>注意</b>：<a href="/s">详情</a></p>')
  })

  it('breaks a container even when it is short', () => {
    const { pretty } = tryFormatMarkup('<div id="wrapper"><a href="/s">搜索</a></div>')
    expect(pretty.split('\n')).toEqual([
      '<div id="wrapper">',
      '  <a href="/s">搜索</a>',
      '</div>',
    ])
  })

  it('breaks an inline element that no longer fits on a line', () => {
    const long = `<span>${'x'.repeat(200)}</span>`
    expect(tryFormatMarkup(long).pretty.split('\n')).toHaveLength(3)
  })

  it('recovers from unclosed tags instead of indenting forever', () => {
    const { pretty } = tryFormatMarkup('<ul><li>a<li>b</ul><p>after')
    // The second <li> is a sibling of the first, and the page carries on at
    // depth zero rather than being dragged along by an unclosed tag.
    expect(pretty.split('\n')).toEqual(['<ul>', '  <li>a', '  <li>b', '</ul>', '<p>after'])
  })

  it('is stable when run twice', () => {
    const once = tryFormatMarkup(minified).pretty
    expect(tryFormatMarkup(once).pretty).toBe(once)
  })

  it('collapses the whitespace that minifiers leave behind', () => {
    const { pretty } = tryFormatMarkup('<div>\n\n   <p>hello\n   world</p>\n</div>')
    expect(pretty.split('\n')).toEqual(['<div>', '  <p>hello world</p>', '</div>'])
  })
})

describe('markup detection', () => {
  it('accepts documents and fragments', () => {
    for (const text of ['<!DOCTYPE html><html>', '<html><body>', '<?xml version="1.0"?><r/>', '</div>']) {
      expect(looksLikeMarkup(text)).toBe(true)
    }
  })

  it('rejects everything that is not markup', () => {
    // A page served as application/x-gzip is exactly why this is sniffed from
    // the bytes: the header cannot be trusted.
    for (const text of ['', '  ', '{"ok":true}', 'hello <b there', 'a < b', '2 < 3 > 1']) {
      expect(looksLikeMarkup(text)).toBe(false)
      expect(tryFormatMarkup(text).ok).toBe(false)
    }
  })

  it('hands back the original text when it is not markup', () => {
    expect(tryFormatMarkup('not markup').pretty).toBe('not markup')
  })
})

describe('highlighting', () => {
  it('marks tags, attributes and values without losing a character', () => {
    const { pretty } = tryFormatMarkup(minified)
    const nodes = highlightMarkup(pretty)
    expect(textOf(nodes)).toBe(pretty)
    const classes = JSON.stringify(nodes)
    for (const cls of ['mtag', 'mattr', 'mval', 'mdoctype']) expect(classes).toContain(cls)
  })

  it('keeps a comment whole, and keeps text plain', () => {
    const source = '<!-- 注意事项 -->\n<p>正文</p>'
    const nodes = highlightMarkup(source)
    expect(textOf(nodes)).toBe(source)
    const found = (nodes as Array<{ props?: { className?: string } }>).find(
      node => node?.props?.className === 'mcmt'
    )
    expect(found?.props?.className).toBe('mcmt')
  })
})
