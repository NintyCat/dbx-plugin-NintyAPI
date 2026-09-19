import { hostBridge, invokeHost } from './bridge'

/**
 * The workbench renders the plugin in a sandboxed iframe (sandbox="allow-scripts"),
 * which gives the document an opaque origin. The browser's permissions policy
 * therefore rejects every async Clipboard API call, and WebKit refuses scripted
 * pasting outright, so neither copy nor paste can be served by the web platform
 * alone. Each operation walks the layers that can still reach the system
 * clipboard: the host bridge, the web API, a legacy textarea, and — for text
 * this side can read itself — the plugin's own backend process.
 */

/** Copy text, reporting whether any layer succeeded. */
export async function copyText(text: string): Promise<boolean> {
  const b = hostBridge()
  if (b?.copy) {
    try {
      await b.copy(text)
      return true
    } catch {
      // Fall through: an old host, or a refused write.
    }
  }
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through.
  }
  if (legacyCopy(text)) return true
  try {
    await invokeHost('clipboard/write-text', { text })
    return true
  } catch {
    return false
  }
}

/**
 * Read the clipboard's text, or null when no layer can reach it. An empty
 * string means the clipboard holds something that is not text.
 */
export async function readText(): Promise<string | null> {
  try {
    return (await navigator.clipboard.readText()) ?? ''
  } catch {
    // Fall through to the backend, which the sandbox cannot reach.
  }
  try {
    const out = await invokeHost<{ text?: string }>('clipboard/read-text')
    return typeof out?.text === 'string' ? out.text : ''
  } catch {
    return null
  }
}

/**
 * Copy through a hidden textarea. execCommand still works inside the sandbox
 * because the call happens synchronously within the click that triggered it.
 * The focused element is restored, since selecting the scratch textarea
 * displaces the user's caret.
 */
function legacyCopy(text: string): boolean {
  const active = document.activeElement
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.setAttribute('readonly', '')
  scratch.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0'
  document.body.appendChild(scratch)
  scratch.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  scratch.remove()
  if (active instanceof HTMLElement) active.focus()
  return ok
}
