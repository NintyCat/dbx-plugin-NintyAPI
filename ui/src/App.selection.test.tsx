import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// jsdom loads no stylesheets (document.styleSheets is empty), so nothing here
// can be asserted against computed style. These check the sheet's own text
// instead, which is what actually decides the behaviour in the host.
const css = readFileSync('src/index.css', 'utf8')

/** The selector text and declaration block of the first rule matching `head`. */
function rule(head: string): { selector: string; body: string } {
  const at = css.indexOf(head)
  expect(at, `no rule starting with ${head}`).toBeGreaterThanOrEqual(0)
  const brace = css.indexOf('{', at)
  const end = css.indexOf('}', brace)
  return { selector: css.slice(at, brace).trim(), body: css.slice(brace + 1, end) }
}

/** Declarations only — the sheet's comments talk about the same words. */
const declarations = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the selection policy', () => {
  it('denies selection at the root, so the default is off', () => {
    const { body } = rule('body {')
    expect(body).toMatch(/user-select:\s*none/)
  })

  it('re-allows it only for the text worth copying', () => {
    const { selector, body } = rule('input,\ntextarea,')
    expect(body).toMatch(/user-select:\s*text/)
    // Each of these carries read-only text a user copies: the response payload
    // and its error, generated code, header/cookie values, and the notice.
    for (const each of ['input', 'textarea', '[contenteditable]', '.resp-body pre', '.resp-error', '.dlg-code', '.headers-table', '.notice']) {
      expect(selector, `${each} should be in the allow-list`).toContain(each)
    }
  })

  it('keeps the request body’s decoration layer out of the selection', () => {
    // The coloured pre behind the transparent textarea holds no selectable text
    // of its own; the textarea over it owns the caret.
    const { body } = rule('.code-editor pre {')
    expect(body).toMatch(/user-select:\s*none/)
  })

  it('does not put the root rule on the fields themselves', () => {
    // Inputs keep selection because it is the editing affordance — drag to
    // replace a value, select-all to retype. The root rule denies the default;
    // the fields are re-allowed by their own rule, never left to inherit a
    // blanket `none` from a selector that also matches them.
    const { body } = rule('body {')
    expect(declarations(body)).not.toMatch(/input|textarea/)
  })
})
