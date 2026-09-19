import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyHostSurfaces, applyThemeTokens, markComponentKit } from './hostSurface'

export type Invoke = <T>(
  method: string,
  params?: Record<string, unknown>
) => Promise<T>

type Context = {
  connectionId?: string
  connectionName?: string
  [key: string]: unknown
}
type Bridge = {
  ready: Promise<void>
  context?: Context
  locale?: string
  theme?: { appearance?: string; tokens?: Record<string, string> }
  invoke(
    method: string,
    params: unknown,
    options?: { timeoutMs: number }
  ): Promise<unknown>
  onContext?(fn: (context: Context) => void): () => void
  /** DBX ≥ 0.6.15 lends the plugin the host's own clipboard writer. */
  copy?(text: string): Promise<unknown>
}

const bridge = () =>
  (window as unknown as { dbxPlugin?: Bridge }).dbxPlugin

/** The host bridge, for helpers that work outside React. */
export function hostBridge(): Bridge | undefined {
  return bridge()
}

/** Call a backend RPC without going through the hook. */
export async function invokeHost<T>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const b = bridge()
  if (!b) throw new Error('DBX 桥接不可用，请通过 DBX 宿主打开页面')
  await b.ready
  return (await b.invoke(method, params, { timeoutMs: 310000 })) as T
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error)
    return String(error.message)
  return String(error)
}

export type HostState = {
  connectionId: string
  connectionLabel: string
  invoke: Invoke
  error: string
  locale: string
  appearance: 'light' | 'dark'
}

export function useBridgeHost(): HostState {
  const [state, setState] = useState<{
    connectionId: string
    connectionLabel: string
    error: string
    locale: string
    hostAppearance: 'light' | 'dark'
  }>({
    connectionId: '',
    connectionLabel: '',
    error: '',
    locale: 'zh-CN',
    hostAppearance: 'dark',
  })
  const connectionRef = useRef('')
  const hostAppearanceRef = useRef<'light' | 'dark'>('dark')
  /** Theme tokens this plugin wrote itself, so stale ones can be dropped. */
  const appliedTokensRef = useRef<Record<string, string>>({})
  /** True once the host has shown a wallpaper; see applyHostSurfaces. */
  const wallpaperSeenRef = useRef(false)

  /** Reads the host's canvas tokens; they live as inline vars on the root. */
  const readHostToken = useCallback(
    (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name),
    []
  )

  const applyAppearance = useCallback(() => {
    document.documentElement.dataset.theme = hostAppearanceRef.current
    // The host stamps its tokens as inline custom properties, so this runs after
    // every theme/env push. A DBX wallpaper makes those tokens translucent and
    // we then paint nothing, letting the host's own layer show the image.
    wallpaperSeenRef.current = applyHostSurfaces(
      document.documentElement,
      readHostToken,
      wallpaperSeenRef.current
    )
  }, [readHostToken])

  const applyTokens = useCallback((tokens?: Record<string, string>) => {
    appliedTokensRef.current = applyThemeTokens(
      document.documentElement,
      tokens,
      appliedTokensRef.current
    )
  }, [])

  useEffect(() => {
    const b = bridge()
    if (!b) {
      setState(s => ({ ...s, error: '请通过 DBX 插件开发主机打开此页面' }))
      applyAppearance()
      return
    }
    let alive = true
    const applyContext = (c: Context) => {
      if (!alive) return
      connectionRef.current = c.connectionId || ''
      setState(s => ({
        ...s,
        connectionId: c.connectionId || '',
        connectionLabel: c.connectionName || c.connectionId || '',
      }))
    }
    const applyEnv = () => {
      if (!alive) return
      const appearance = (b.theme?.appearance as 'light' | 'dark') || 'dark'
      hostAppearanceRef.current = appearance
      applyTokens(b.theme?.tokens)
      setState(s => ({
        ...s,
        locale: b.locale || 'zh-CN',
        hostAppearance: appearance,
      }))
      applyAppearance()
    }
    /**
     * Re-reads the host canvases without touching appearance. The host stamps
     * tokens as inline vars, and DBX does not push a theme update when the user
     * toggles a wallpaper, so a style mutation or poll tick is the only chance
     * to notice. applyHostSurfaces is a no-op when nothing changed.
     */
    const refreshSurfaces = () => {
      if (!alive) return
      wallpaperSeenRef.current = applyHostSurfaces(
        document.documentElement,
        readHostToken,
        wallpaperSeenRef.current
      )
    }
    const off = b.onContext?.(applyContext)
    b.ready
      .then(() => {
        if (!alive) return
        // The host may inject its component stylesheet after our first paint.
        markComponentKit()
        applyContext(b.context || {})
        applyEnv()
      })
      .catch(e => {
        if (alive) setState(s => ({ ...s, error: errorText(e) }))
      })
    // The host announces theme changes via dbx-plugin-env, but some hosts
    // only stamp the attribute through the bridge's applyTheme. Watch both
    // and poll as a last resort so "follow host" never goes stale.
    window.addEventListener('dbx-plugin-env', applyEnv)
    const observer = new MutationObserver(() => {
      const stamped = document.documentElement.getAttribute('data-dbx-theme')
      if (
        (stamped === 'light' || stamped === 'dark') &&
        stamped !== hostAppearanceRef.current
      ) {
        applyEnv()
        return
      }
      // Inline token writes (a wallpaper being applied or cleared) land here.
      refreshSurfaces()
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dbx-theme', 'style'],
    })
    const poll = window.setInterval(() => {
      if (!alive) return
      const stamped = document.documentElement.getAttribute('data-dbx-theme')
      if (
        (stamped === 'light' || stamped === 'dark') &&
        stamped !== hostAppearanceRef.current
      ) {
        applyEnv()
        return
      }
      const bridged = b.theme?.appearance
      if (
        (bridged === 'light' || bridged === 'dark') &&
        bridged !== hostAppearanceRef.current
      ) {
        applyEnv()
        return
      }
      refreshSurfaces()
    }, 600)
    return () => {
      alive = false
      off?.()
      window.removeEventListener('dbx-plugin-env', applyEnv)
      observer.disconnect()
      window.clearInterval(poll)
    }
  }, [applyAppearance, applyTokens])

  const invoke: Invoke = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}) =>
      invokeHost<T>(method, params),
    []
  )

  return useMemo(
    () => ({
      connectionId: state.connectionId,
      connectionLabel: state.connectionLabel,
      invoke,
      error: state.error,
      locale: state.locale,
      appearance: state.hostAppearance,
    }),
    [state.connectionId, state.connectionLabel, state.error, state.locale, state.hostAppearance, invoke]
  )
}
