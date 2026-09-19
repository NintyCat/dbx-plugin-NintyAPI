// Inlines the built frontend into a single self-contained index.html.
//
// DBX loads the workbench inside an about:srcdoc iframe: relative asset URLs
// cannot resolve there, and no single asset may exceed 8 MiB. This script
// gzip+base64-packs every emitted JS module into an inline bootstrap loader,
// inlines stylesheets, and fails the build if anything external remains.
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '../ui/dist')

function localAsset(href) {
  const path = /^https?:/.test(href) ? new URL(href).pathname : href
  const absolute = resolve(distDir, decodeURIComponent(path.replace(/^\//, '').split(/[?#]/)[0]))
  if (relative(distDir, absolute).startsWith('..')) {
    throw new Error(`Asset outside the build directory: ${href}`)
  }
  return absolute
}

// Labels painted before the bundle boots. The app itself ships the full
// bilingual dictionary — these only cover the loading and failure states.
const bootLabels = {
  en: { loading: '加载中…', error: '出错了' },
  'zh-cn': { loading: '加载中…', error: '出错了' },
  'zh-tw': { loading: '載入中…', error: '發生錯誤' },
}

// The bootstrap runs inside srcdoc. It wires window.localStorage onto the
// connection-scoped preferences RPC (so UI state survives restarts), provides
// a transient sessionStorage, decompresses the packed module, and imports it
// from a blob URL.
function loaderSource(packed) {
  return `
(async () => {
const BOOT = ${JSON.stringify(bootLabels)};
const locale = () => {
  const raw = String(window.dbxPlugin?.locale || navigator.language || 'en').replace(/_/g, '-').toLowerCase();
  if (BOOT[raw]) return raw;
  if (raw.startsWith('zh')) return /tw|hk|hant/.test(raw) ? 'zh-tw' : 'zh-cn';
  if (raw.startsWith('pt')) return 'pt-br';
  return raw.split('-')[0];
};
const say = () => BOOT[locale()] || BOOT.en;
const flash = (message) => {
  let box = document.getElementById('dbx-startup-error');
  if (!box) {
    box = document.createElement('div');
    box.id = 'dbx-startup-error';
    box.setAttribute('role', 'alert');
    document.body.appendChild(box);
  }
  box.textContent = say().error + ': ' + String(message?.message || message);
};
window.addEventListener('error', (event) => flash(event.error || event.message));
window.addEventListener('unhandledrejection', (event) => flash(event.reason));
document.getElementById('root').textContent = say().loading;
try {
  await window.dbxPlugin.ready;
  const connectionId = window.dbxPlugin.context?.connectionId;
  const stored = await window.dbxPlugin.invoke('ui/preferences-get', { connectionId });
  const values = new Map(Object.entries(stored.values || {}));
  let pending = Promise.resolve();
  const queue = (key, value) => {
    pending = pending.then(() => window.dbxPlugin.invoke('ui/preferences-set', { connectionId, key, value })).catch(flash);
  };
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      get length() { return values.size; },
      key(index) { return [...values.keys()][index] ?? null; },
      getItem(key) { return values.get(String(key)) ?? null; },
      setItem(key, value) { key = String(key); value = String(value); values.set(key, value); queue(key, value); },
      removeItem(key) { values.delete(key); queue(key, null); },
      clear() { for (const key of [...values.keys()]) this.removeItem(key); },
    },
  });
  const scratch = new Map();
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      get length() { return scratch.size; },
      key(index) { return [...scratch.keys()][index] ?? null; },
      getItem(key) { return scratch.get(String(key)) ?? null; },
      setItem(key, value) { scratch.set(String(key), String(value)); },
      removeItem(key) { scratch.delete(String(key)); },
      clear() { scratch.clear(); },
    },
  });
  const bytes = Uint8Array.from(atob("${packed}"), (character) => character.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const source = await new Response(stream).text();
  document.getElementById('root').textContent = say().loading;
  const moduleURL = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try { await import(moduleURL); } finally { URL.revokeObjectURL(moduleURL); }
} catch (error) {
  document.getElementById('root').textContent = say().error + ': ' + String(error);
  console.error(error);
}
})();
`
}

let html = await readFile(resolve(distDir, 'index.html'), 'utf8')

for (const match of [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)]) {
  const bundle = await readFile(localAsset(match[1]), 'utf8')
  // DBX caps a single asset at 8 MiB: pack the module, decode it in-page.
  const packed = gzipSync(bundle, { level: 9 }).toString('base64')
  html = html.replace(match[0], '').replace('</body>', `<script>${loaderSource(packed)}</script></body>`)
}

for (const match of [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)]) {
  const css = await readFile(localAsset(match[1]), 'utf8')
  // Fonts and images must already be inlined by Vite — a url() the srcdoc
  // origin cannot fetch would break the stylesheet silently.
  for (const ref of css.matchAll(/url\(\s*['"]?([^'"\s)]+)/g)) {
    if (!/^(data:|blob:|#)/.test(ref[1])) {
      throw new Error(`External CSS asset in srcdoc build: ${ref[1]}`)
    }
  }
  html = html.replace(match[0], `<style>${css.replace(/<\/style/gi, '<\\/style')}</style>`)
}

if (/<script\b[^>]*\bsrc=|<link\b[^>]*rel="(?:stylesheet|modulepreload)"/i.test(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''))) {
  throw new Error('DBX build still contains external executable assets')
}
if (Buffer.byteLength(html) > 8 * 1024 * 1024) {
  throw new Error('DBX HTML exceeds 8 MiB asset limit')
}
await writeFile(resolve(distDir, 'index.html'), html)
