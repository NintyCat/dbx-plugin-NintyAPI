import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The plugin renders inside an isolated iframe, so the host's stylesheet is not
// in this document — but the host does push a fixed token set across the bridge
// (window.dbxPlugin.theme.tokens, and as inline custom properties on the root).
// These check that the plugin reads those tokens rather than inventing its own
// values, which is what keeps a button here looking like a button in DBX.
const css = readFileSync('src/index.css', 'utf8')

/**
 * The tokens DBX stamps on the plugin document. The real host forwards every
 * custom property on its own root whose name starts with `--color`, `--radius`
 * or `--font` (skipping `--dbx-*`), so the families come along with the palette.
 * The dev runtime only simulates the colour and radius subset, which is why the
 * fallbacks in the sheet still matter there.
 */
const HOST_TOKENS = [
  '--color-background',
  '--color-foreground',
  '--color-card',
  '--color-card-foreground',
  '--color-muted',
  '--color-muted-foreground',
  '--color-border',
  '--color-input',
  '--color-ring',
  '--color-primary',
  '--color-primary-foreground',
  '--color-destructive',
  '--color-destructive-foreground',
  '--radius-md',
  '--radius-lg',
  '--font-sans',
]

/** Declarations only; the sheet's comments mention the same token names. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')

/**
 * Every declaration block of one rule, joined. A selector can be declared more
 * than once — `.code-editor pre` and `.dlg textarea` both are — and it can also
 * appear in a grouped selector list, so both cases have to be collected:
 * looking only at the first match would quietly assert nothing about the rest.
 */
function block(selector: string) {
  const found: string[] = []
  for (const [, selectors, body] of decls.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (selectors.split(',').some(each => each.trim() === selector)) found.push(body)
  }
  expect(found.length, `${selector} not found`).toBeGreaterThan(0)
  return found.join('\n')
}

/** Every `font-family` value a rule declares, in source order. */
const families = (body: string) =>
  [...body.matchAll(/font-family:\s*([^;]+)/g)].map(match => match[1].trim())

/**
 * Surfaces that used to pick a family of their own. They inherit now, so the
 * list is a guard: naming a family on any of them re-introduces text that
 * ignores the font chosen in DBX — which is the bug this replaced.
 */
const INHERITING_SURFACES = [
  '.method',
  '.st-ok',
  '.st-bad',
  '.row-sub',
  '.method-select .pick-trigger',
  '.url-input',
  '.status.pill',
  '.meta',
  '.file-name',
  '.file-chip-name',
  '.env-row .env-base',
  '.headers-table',
  '.dlg textarea',
]

/**
 * The surfaces the browser would otherwise keep on its own font: every <pre>
 * plus the two bare textareas. Leaving `font-family` off one of these is not
 * neutral — the UA font wins and the surface stops following DBX.
 */
const UA_FONT_SURFACES = [
  '.code-editor pre',
  '.code-editor .code-input',
  '.resp-body pre',
  '.resp-error',
  '.body-content',
  '.dlg-code',
]

describe('the plugin reads the host’s tokens', () => {
  it('only falls back to tokens the host actually pushes', () => {
    // Every `var(--color-…)` / `var(--radius-…)` / `var(--font-…)` this sheet
    // names must be a real host token. A misspelled one silently yields the
    // fallback forever, so the control stops following the theme without
    // anything looking broken.
    const referenced = [...decls.matchAll(/var\((--(?:color|radius|font)-[a-z0-9-]+)/g)].map(m => m[1])
    const unknown = [...new Set(referenced)].filter(name => !HOST_TOKENS.includes(name))
    expect(unknown, `not host tokens: ${unknown.join(', ')}`).toEqual([])
  })

  it('takes the accent and its text colour from the host as a pair', () => {
    // The pairing matters: on a dark theme DBX's primary is a light blue whose
    // text is near-black. A hardcoded white label would be unreadable there.
    expect(decls).toMatch(/--accent:\s*var\(--color-primary,/)
    expect(decls).toMatch(/--accent-fg:\s*var\(--color-primary-foreground,/)
  })

  it('takes the destructive colour and its text colour from the host', () => {
    expect(decls).toMatch(/--bad:\s*var\(--color-destructive,/)
    expect(decls).toMatch(/--bad-fg:\s*var\(--color-destructive-foreground,/)
  })

  it('takes the corner radius from the host, in both themes', () => {
    // DBX pushes `--radius-md`; declaring a bare number here would drift from
    // every other control the moment the user picks a rounder palette.
    expect(decls).toMatch(/--radius:\s*var\(--radius-md,/)
    // The dark block must not re-declare a literal either.
    const dark = decls.slice(decls.indexOf("[data-theme='dark']"))
    expect(dark).not.toMatch(/--radius:\s*\d/)
  })

  it('keeps the accent buttons quiet with labels read from the host tokens', () => {
    // The accent/destructive/send buttons are bordered, not filled, so there is
    // no background to pair a foreground with — but the label still must not be
    // a literal: on a dark theme the host's hues change under it. Colour comes
    // from the plugin tokens, which in turn come from the host.
    for (const selector of ['button.primary', 'button.danger', 'button.send']) {
      const body = block(selector)
      expect(body, `${selector} must not hardcode a white label`).not.toMatch(/color:\s*#fff/i)
      expect(body, `${selector} must read its colour from a token`).toMatch(/color:\s*var\(--/)
    }
    expect(decls).toMatch(/button\.primary\s*\{[^}]*color:\s*var\(--accent\)/)
    expect(decls).toMatch(/button\.danger\s*\{[^}]*color:\s*var\(--bad\)/)
  })

  it('takes the font from the host rather than a literal stack', () => {
    // The host re-pushes its tokens whenever the font setting changes, so the
    // family has to sit behind a var() to follow it; a literal stack here would
    // pin the plugin to one font for the life of the tab.
    expect(decls).toMatch(/font:\s*13px\/1\.5\s*var\(--font-sans,/)
  })

  it('leaves the whole workbench on the interface font', () => {
    // One family for the sheet: body reads --font-sans and nothing else names
    // one. DBX's editor font is monospace-only, so putting the request line or
    // the response body on it would strand them whenever the user changes the
    // interface font — the plugin would look like it ignored the setting.
    expect(decls).not.toMatch(/--font-mono/)
    for (const selector of INHERITING_SURFACES) {
      const body = block(selector)
      expect(families(body), `${selector} must not pin a family`).toEqual([])
      expect(body, `${selector} must not hide a family in a shorthand`).not.toMatch(
        /(?<![-\w])font:\s/
      )
    }
  })

  it('pulls the <pre> surfaces off the browser’s monospace', () => {
    // These are the ones a missing declaration would strand: the UA stylesheet
    // wins for <pre>, so `inherit` has to be said out loud.
    for (const selector of UA_FONT_SURFACES) {
      expect(families(block(selector)), `${selector} must inherit`).toEqual(['inherit'])
    }
  })

  it('keeps the dark block from re-hardcoding the host colours it inherits', () => {
    const dark = decls.slice(decls.indexOf("[data-theme='dark']"))
    // Both blocks name the same host tokens; a literal in the dark block would
    // override the host value for dark mode only.
    expect(dark).toMatch(/--bad:\s*var\(--color-destructive,/)
    expect(dark).toMatch(/--accent:\s*var\(--color-primary,/)
  })
})
