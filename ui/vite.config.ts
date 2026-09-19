import { execFileSync } from 'node:child_process'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

// DBX renders the workbench inside an about:srcdoc iframe. Relative module
// URLs cannot resolve from that opaque origin, so a release build must emit
// exactly one self-contained HTML file (the inline step below), while the
// preview keeps asset URLs on the dev server origin instead.
export default defineConfig({
  base: process.env.DBX_PREVIEW_ORIGIN || './',
  plugins: [
    react(),
    {
      // The inline step is what makes the single-file build installable, and
      // the echoed marker tells the dev host the bundle is ready.
      name: 'dbx-inline-and-signal',
      closeBundle() {
        execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/inline-ui-assets.mjs', import.meta.url))], { stdio: 'inherit' })
        console.log('DBX_UI_BUILD_SUCCESS')
      },
    },
  ],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rolldownOptions: { output: { codeSplitting: false, format: 'es' } },
  },
})
