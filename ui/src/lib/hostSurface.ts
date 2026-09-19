/**
 * Lets a DBX wallpaper (设置 → 背景图) show through the plugin workbench.
 *
 * The host pushes its design tokens into the sandbox as inline custom
 * properties on the sandbox document, so they are readable after
 * `dbxPlugin.ready` resolves. While a wallpaper is active the host re-emits
 * `--color-background` with alpha.
 *
 * That alpha is the whole signal, and the plugin must react by painting
 * *nothing*: DBX already paints its own translucent surface on the host side of
 * the iframe, so a second translucent layer here would multiply the opacity
 * (0.8 x 0.8 ≈ 0.96) and hide the image. Clearing the overrides is therefore
 * the goal — it lets the stylesheet fall back to this plugin's own opaque
 * palette, which is also what keeps the normal (no wallpaper) look unchanged.
 *
 * Raised surfaces (menus, dialogs, editors) stay opaque via CSS either way,
 * mirroring how DBX keeps its own card/popover surfaces opaque over a wallpaper.
 */

const CANVAS_TOKENS = ['--color-background', '--color-background-secondary']

/** Sidebar/rail canvas override; set to `transparent` only while wallpapered. */
export const PLUGIN_BG_VAR = '--dbx-plugin-bg'
/** Main content canvas override; set to `transparent` only while wallpapered. */
export const PLUGIN_CANVAS_VAR = '--dbx-plugin-canvas'

const COLOR_FUNCTION_RE =
  /^(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color|color-mix)\(.*\)$/i
const HEX_RE = /^#[0-9a-f]{3,8}$/i

/** A value the browser accepts as a color, with no unresolved var(). */
export function isResolvedColor(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed || trimmed.includes('var(')) return false
  return HEX_RE.test(trimmed) || COLOR_FUNCTION_RE.test(trimmed)
}

function clampAlpha(value: number): number {
  return Math.min(1, Math.max(0, value))
}

/** An alpha channel written either as a fraction or as a percentage. */
function alphaOf(text: string): number | null {
  const value = Number.parseFloat(text)
  if (!Number.isFinite(value)) return null
  return clampAlpha(text.includes('%') ? value / 100 : value)
}

/**
 * Alpha channel of a resolved color, or null when it cannot be determined.
 * Covers the forms DBX emits: hex, `rgb(r g b / a)`, `rgba(r, g, b, a)`, and
 * the modern slash syntax for the other color functions.
 */
export function colorAlpha(value: string): number | null {
  const trimmed = value.trim()
  if (!isResolvedColor(trimmed)) return null
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1)
    if (hex.length === 4) return parseInt(hex[3] + hex[3], 16) / 255
    if (hex.length === 8) return parseInt(hex.slice(6, 8), 16) / 255
    return 1
  }
  const open = trimmed.indexOf('(')
  const close = trimmed.lastIndexOf(')')
  if (open < 0 || close < 0) return null
  const inner = trimmed.slice(open + 1, close)
  const slash = inner.split('/')
  if (slash.length === 2) return alphaOf(slash[1])
  const parts = inner.split(',')
  if (parts.length === 4) return alphaOf(parts[3])
  return 1
}

/**
 * True when any host canvas token carries alpha, i.e. DBX has a wallpaper
 * active. Unreadable tokens (dev host, older DBX, still-unresolved var())
 * count as no wallpaper, so the plugin keeps its own opaque palette.
 */
export function isWallpaperActive(read: (name: string) => string): boolean {
  return CANVAS_TOKENS.some((name) => {
    const alpha = colorAlpha(read(name))
    return alpha !== null && alpha < 1
  })
}

/** Clears both overrides so the stylesheet's opaque fallbacks apply again. */
export function clearHostSurfaces(root: HTMLElement): void {
  root.style.removeProperty(PLUGIN_BG_VAR)
  root.style.removeProperty(PLUGIN_CANVAS_VAR)
}

/** Token names look like CSS custom properties and nothing else. */
const TOKEN_NAME_RE = /^--[a-z0-9-]+$/i

/**
 * True when the host has injected its own component kit — `dbx-select`,
 * `dbx-input`, `dbx-btn`, … — into this document.
 *
 * DBX ships those classes, styled with the same theme tokens, so a control
 * carrying the class looks exactly like the same control elsewhere in DBX. The
 * development host does not emulate the kit, so the plugin keeps its own skin
 * for that case: otherwise the debug page would show raw platform widgets in
 * the middle of a themed workbench.
 *
 * The probe compares a control with the class against one without it, because
 * the kit's stylesheet is not something a plugin can enumerate.
 */
/** Records the answer on the root, where the stylesheet can read it. */
export function markComponentKit(doc: Document = document): boolean {
  const present = hostComponentKitAvailable(doc)
  doc.documentElement.dataset.dbxKit = present ? 'present' : 'absent'
  return present
}

export function hostComponentKitAvailable(doc: Document = document): boolean {
  const view = doc.defaultView
  const probe = doc.createElement('select')
  const bare = doc.createElement('select')
  for (const element of [probe, bare]) {
    element.setAttribute('aria-hidden', 'true')
    element.style.position = 'absolute'
    element.style.left = '-9999px'
  }
  probe.className = 'dbx-select'
  doc.body.append(probe, bare)
  const styled = view?.getComputedStyle(probe)
  const plain = view?.getComputedStyle(bare)
  const present = Boolean(
    styled &&
      plain &&
      (styled.borderRadius !== plain.borderRadius ||
        styled.backgroundColor !== plain.backgroundColor ||
        styled.paddingLeft !== plain.paddingLeft ||
        styled.fontSize !== plain.fontSize)
  )
  probe.remove()
  bare.remove()
  return present
}

/**
 * Writes the host's theme tokens onto the root, and reports what it wrote so
 * the next call can drop the ones it wrote before.
 *
 * The host bridge usually stamps these itself when it applies a theme, but a
 * plugin that only reads them keeps the old palette whenever a stamp does not
 * arrive — which is what a theme switch that changes nothing looks like.
 * `theme.tokens` travels with every push, so applying them from here keeps the
 * workbench on the host's colours either way.
 *
 * Two things must survive the write: a value the host has made translucent, and
 * a value this plugin did not write. The host signals a background image —
 * 设置 → 背景图 — by re-emitting the canvas token with alpha, and the theme's
 * opaque twin would wipe that out, leaving the workbench painting a solid
 * canvas over the image. Symmetrically, only a value still equal to the one we
 * wrote may be removed; anything else belongs to the host.
 *
 * @param applied tokens written by the previous call, by name
 * @returns the tokens written now
 */
export function applyThemeTokens(
  root: HTMLElement,
  tokens: Record<string, string> | undefined,
  applied: Record<string, string>
): Record<string, string> {
  const written: Record<string, string> = {}
  for (const [name, value] of Object.entries(tokens ?? {})) {
    if (!TOKEN_NAME_RE.test(name) || typeof value !== 'string') continue
    written[name] = value
    const current = root.style.getPropertyValue(name).trim()
    if (current === value.trim()) continue
    const alpha = colorAlpha(current)
    if (alpha !== null && alpha < 1) continue
    root.style.setProperty(name, value)
    written[name] = value
  }
  for (const [name, value] of Object.entries(applied)) {
    if (!(name in written) && root.style.getPropertyValue(name).trim() === value.trim()) {
      root.style.removeProperty(name)
    }
  }
  return written
}

/**
 * Publishes `transparent` to the structural canvases while a wallpaper is
 * active, and clears the overrides otherwise.
 *
 * Writes only when the state actually changes: this runs from a poll as well as
 * from theme pushes, and re-setting the same inline property every tick would
 * keep marking the root dirty.
 *
 * @returns whether a wallpaper is active.
 */
export function applyHostSurfaces(
  root: HTMLElement,
  read: (name: string) => string,
  sawWallpaper = false
): boolean {
  // A wallpaper that has been seen stays assumed. The host stops emitting the
  // translucent canvas when the theme changes — the token comes back opaque —
  // so re-reading it alone would drop the image and paint a solid canvas over
  // it. Once the image is showing, only staying unpainted keeps it showing.
  const wallpaper = sawWallpaper || isWallpaperActive(read)
  if (wallpaper) {
    if (root.style.getPropertyValue(PLUGIN_BG_VAR) !== 'transparent') {
      root.style.setProperty(PLUGIN_BG_VAR, 'transparent')
      root.style.setProperty(PLUGIN_CANVAS_VAR, 'transparent')
    }
    return true
  }
  if (root.style.getPropertyValue(PLUGIN_BG_VAR) || root.style.getPropertyValue(PLUGIN_CANVAS_VAR)) {
    clearHostSurfaces(root)
  }
  return false
}
