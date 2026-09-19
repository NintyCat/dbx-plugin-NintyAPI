import { describe, expect, it } from 'vitest'
import {
  PLUGIN_BG_VAR,
  PLUGIN_CANVAS_VAR,
  applyHostSurfaces,
  applyThemeTokens,
  clearHostSurfaces,
  colorAlpha,
  hostComponentKitAvailable,
  isResolvedColor,
  isWallpaperActive,
  markComponentKit,
} from './hostSurface'

/** Builds a token reader over a plain token map, like the host's inline vars. */
function reader(tokens: Record<string, string>) {
  return (name: string) => tokens[name] ?? ''
}

describe('isResolvedColor', () => {
  it('accepts the color forms DBX emits', () => {
    expect(isResolvedColor('#fff')).toBe(true)
    expect(isResolvedColor('#1c1d21')).toBe(true)
    expect(isResolvedColor('rgb(19 20 22)')).toBe(true)
    expect(isResolvedColor('rgb(19 20 22 / 0.8)')).toBe(true)
    expect(isResolvedColor('rgba(19, 20, 22, 0.8)')).toBe(true)
    expect(isResolvedColor('oklch(0.5 0.1 200)')).toBe(true)
  })

  it('rejects empty values and unresolved var() references', () => {
    expect(isResolvedColor('')).toBe(false)
    expect(isResolvedColor('   ')).toBe(false)
    expect(isResolvedColor('var(--background)')).toBe(false)
    expect(isResolvedColor('rgb(19 20 22 / var(--alpha))')).toBe(false)
  })
})

describe('colorAlpha', () => {
  it('reads alpha out of every emitted form', () => {
    expect(colorAlpha('#1c1d21')).toBe(1)
    expect(colorAlpha('#fff')).toBe(1)
    expect(colorAlpha('rgb(19 20 22)')).toBe(1)
    expect(colorAlpha('rgb(19 20 22 / 0.8)')).toBeCloseTo(0.8)
    expect(colorAlpha('rgba(19, 20, 22, 0.8)')).toBeCloseTo(0.8)
    expect(colorAlpha('#1c1d2180')).toBeCloseTo(128 / 255)
    expect(colorAlpha('#abcd')).toBeCloseTo(0xdd / 255)
  })

  it('returns null for values it cannot parse', () => {
    expect(colorAlpha('')).toBeNull()
    expect(colorAlpha('var(--background)')).toBeNull()
    expect(colorAlpha('transparent')).toBeNull()
  })
})

describe('isWallpaperActive', () => {
  it('is false when the host pushes nothing (dev host, older DBX)', () => {
    expect(isWallpaperActive(reader({}))).toBe(false)
  })

  it('is false for the normal opaque surfaces', () => {
    expect(
      isWallpaperActive(
        reader({
          '--color-background': 'rgb(255 255 255)',
          '--color-background-secondary': 'rgb(246 247 249)',
        })
      )
    ).toBe(false)
  })

  it('is true when a surface token carries alpha, i.e. a wallpaper is active', () => {
    expect(isWallpaperActive(reader({ '--color-background': 'rgb(255 255 255 / 0.8)' }))).toBe(true)
    expect(
      isWallpaperActive(reader({ '--color-background-secondary': 'rgb(246 247 249 / 0.8)' }))
    ).toBe(true)
  })

  it('ignores unresolved tokens rather than treating them as a wallpaper', () => {
    expect(isWallpaperActive(reader({ '--color-background': 'var(--background)' }))).toBe(false)
  })
})

describe('applyHostSurfaces', () => {
  it('paints nothing while a wallpaper is active so the host layer shows through', () => {
    const root = document.createElement('div')
    const active = applyHostSurfaces(root, reader({ '--color-background': 'rgb(255 255 255 / 0.8)' }))

    expect(active).toBe(true)
    expect(root.style.getPropertyValue(PLUGIN_BG_VAR)).toBe('transparent')
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('transparent')
  })

  it('clears the overrides when no wallpaper is active, restoring the opaque palette', () => {
    const root = document.createElement('div')
    root.style.setProperty(PLUGIN_BG_VAR, 'transparent')
    root.style.setProperty(PLUGIN_CANVAS_VAR, 'transparent')

    const active = applyHostSurfaces(root, reader({ '--color-background': 'rgb(255 255 255)' }))

    expect(active).toBe(false)
    expect(root.style.getPropertyValue(PLUGIN_BG_VAR)).toBe('')
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('')
  })

  it('clears overrides when the host stops pushing tokens', () => {
    const root = document.createElement('div')
    root.style.setProperty(PLUGIN_BG_VAR, 'transparent')

    applyHostSurfaces(root, reader({}))

    expect(root.style.getPropertyValue(PLUGIN_BG_VAR)).toBe('')
  })
})

describe('clearHostSurfaces', () => {
  it('removes both overrides', () => {
    const root = document.createElement('div')
    root.style.setProperty(PLUGIN_BG_VAR, 'transparent')
    root.style.setProperty(PLUGIN_CANVAS_VAR, 'transparent')

    clearHostSurfaces(root)

    expect(root.style.getPropertyValue(PLUGIN_BG_VAR)).toBe('')
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('')
  })
})

describe('applying the host theme tokens', () => {
  it('writes each token and reports what it wrote', () => {
    const root = document.createElement('div')
    const applied = applyThemeTokens(root, { '--color-background': '#18181b', '--color-card': '#1b1b1f' }, {})
    expect(applied).toEqual({ '--color-background': '#18181b', '--color-card': '#1b1b1f' })
    expect(root.style.getPropertyValue('--color-background')).toBe('#18181b')
    expect(root.style.getPropertyValue('--color-card')).toBe('#1b1b1f')
  })

  it('overwrites a value the host changed', () => {
    const root = document.createElement('div')
    const first = applyThemeTokens(root, { '--color-background': '#ffffff' }, {})
    applyThemeTokens(root, { '--color-background': '#18181b' }, first)
    expect(root.style.getPropertyValue('--color-background')).toBe('#18181b')
  })

  // 设置 → 背景图: the host re-emits the canvas token with alpha, and that
  // translucent value is what keeps the workbench from covering the image.
  it('never overwrites a translucent canvas the host has already set', () => {
    const root = document.createElement('div')
    root.style.setProperty('--color-background', 'rgba(255, 255, 255, 0.72)')
    applyThemeTokens(root, { '--color-background': '#ffffff' }, {})
    expect(root.style.getPropertyValue('--color-background')).toBe('rgba(255, 255, 255, 0.72)')
  })

  it('reads an alpha written as a percentage', () => {
    expect(colorAlpha('rgba(255, 255, 255, 85%)')).toBeCloseTo(0.85)
    expect(colorAlpha('oklch(0.7 0 0 / 40%)')).toBeCloseTo(0.4)
    expect(colorAlpha('rgb(255 255 255 / 0.6)')).toBeCloseTo(0.6)
  })

  it('drops a token it wrote itself, once the host stops sending it', () => {
    const root = document.createElement('div')
    const first = applyThemeTokens(root, { '--color-background': '#ffffff', '--color-ring': '#93c5fd' }, {})
    const second = applyThemeTokens(root, { '--color-background': '#18181b' }, first)
    expect(second).toEqual({ '--color-background': '#18181b' })
    expect(root.style.getPropertyValue('--color-ring')).toBe('')
  })

  it('leaves a value alone when it is not the one this plugin wrote', () => {
    const root = document.createElement('div')
    const first = applyThemeTokens(root, { '--color-ring': '#93c5fd' }, {})
    root.style.setProperty('--color-ring', '#ff0000') // the host moved on by itself
    applyThemeTokens(root, {}, first)
    expect(root.style.getPropertyValue('--color-ring')).toBe('#ff0000')
  })

  it('ignores junk names and non-string values', () => {
    const root = document.createElement('div')
    const applied = applyThemeTokens(
      root,
      { color: 'red', '--bad name': 'red', '--ok': 'red', '--num': 12 as unknown as string },
      {}
    )
    expect(applied).toEqual({ '--ok': 'red' })
    expect(root.style.getPropertyValue('--ok')).toBe('red')
  })

  it('leaves the root alone when the host pushes nothing', () => {
    const root = document.createElement('div')
    expect(applyThemeTokens(root, undefined, {})).toEqual({})
    expect(root.style.cssText).toBe('')
  })
})

describe('a wallpaper that has been seen', () => {
  const opaque = reader({ '--color-background': 'oklch(100% 0 0)', '--color-background-secondary': '#ffffff' })
  const wallpapered = reader({ '--color-background': 'rgba(255, 255, 255, 0.72)' })

  it('keeps the canvases unpainted after the host stops marking them', () => {
    const root = document.createElement('div')
    expect(applyHostSurfaces(root, wallpapered)).toBe(true)
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('transparent')
    // The theme changed: the host now sends an opaque canvas again.
    expect(applyHostSurfaces(root, opaque, true)).toBe(true)
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('transparent')
    expect(root.style.getPropertyValue(PLUGIN_BG_VAR)).toBe('transparent')
  })

  it('still paints when no wallpaper was ever seen', () => {
    const root = document.createElement('div')
    expect(applyHostSurfaces(root, opaque)).toBe(false)
    expect(root.style.getPropertyValue(PLUGIN_CANVAS_VAR)).toBe('')
  })
})

describe('the host component kit probe', () => {
  it('reports no kit when nothing styles dbx-select', () => {
    expect(hostComponentKitAvailable(document)).toBe(false)
    expect(markComponentKit(document)).toBe(false)
    expect(document.documentElement.dataset.dbxKit).toBe('absent')
  })

  it('reports the kit once a host stylesheet gives dbx-select a look', () => {
    const style = document.createElement('style')
    style.textContent = '.dbx-select { border-radius: 11px; }'
    document.head.append(style)
    expect(markComponentKit(document)).toBe(true)
    expect(document.documentElement.dataset.dbxKit).toBe('present')
    style.remove()
    markComponentKit(document)
  })

  it('leaves no probe elements behind', () => {
    const before = document.body.childElementCount
    hostComponentKitAvailable(document)
    expect(document.body.childElementCount).toBe(before)
  })
})
