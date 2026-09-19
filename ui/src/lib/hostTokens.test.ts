import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The plugin renders inside an isolated iframe, so the host's stylesheet is not
// in this document — but the host does push a fixed token set across the bridge
// (window.dbxPlugin.theme.tokens, and as inline custom properties on the root).
// These check that the plugin reads those tokens rather than inventing its own
// values, which is what keeps a button here looking like a button in DBX.
const css = readFileSync('src/index.css', 'utf8')

/**
 * The tokens DBX stamps on the plugin document. Taken from the dev runtime's
 * own theme table — the host-side contract this plugin is written against.
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
]

/** Declarations only; the sheet's comments mention the same token names. */
const decls = css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the plugin reads the host’s tokens', () => {
  it('only falls back to tokens the host actually pushes', () => {
    // Every `var(--color-…)` / `var(--radius-…)` this sheet names must be a real
    // host token. A misspelled one silently yields the fallback forever, so the
    // control stops following the theme without anything looking broken.
    const referenced = [...decls.matchAll(/var\((--(?:color|radius)-[a-z0-9-]+)/g)].map(m => m[1])
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
      const at = decls.indexOf(`${selector} {`)
      expect(at, `${selector} not found`).toBeGreaterThanOrEqual(0)
      const body = decls.slice(at, decls.indexOf('}', at))
      expect(body, `${selector} must not hardcode a white label`).not.toMatch(/color:\s*#fff/i)
      expect(body, `${selector} must read its colour from a token`).toMatch(/color:\s*var\(--/)
    }
    expect(decls).toMatch(/button\.primary\s*\{[^}]*color:\s*var\(--accent\)/)
    expect(decls).toMatch(/button\.danger\s*\{[^}]*color:\s*var\(--bad\)/)
  })

  it('keeps the dark block from re-hardcoding the host colours it inherits', () => {
    const dark = decls.slice(decls.indexOf("[data-theme='dark']"))
    // Both blocks name the same host tokens; a literal in the dark block would
    // override the host value for dark mode only.
    expect(dark).toMatch(/--bad:\s*var\(--color-destructive,/)
    expect(dark).toMatch(/--accent:\s*var\(--color-primary,/)
  })
})
