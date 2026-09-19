import '@testing-library/jest-dom/vitest'

// jsdom lacks two browser APIs the workbench mounts depend on; provide minimal
// stand-ins so component tests can render without skipping.

if (!globalThis.ResizeObserver) {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
}

if (!window.matchMedia) {
  const stub = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
  window.matchMedia = (query: string) => stub(query)
}
