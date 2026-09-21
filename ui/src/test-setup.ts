import '@testing-library/jest-dom/vitest'

// jsdom lacks a few browser APIs the workbench mounts depend on; provide
// minimal stand-ins so component tests can render without skipping.

if (!globalThis.ResizeObserver) {
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver
}

// jsdom's Blob predates arrayBuffer(), which every browser has had for years and
// which reading a picked file depends on. FileReader is implemented, so the two
// are bridged here rather than contorting the upload code around a test gap.
if (typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(reader.error ?? new Error('could not read the blob'))
      reader.readAsArrayBuffer(this)
    })
  }
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
