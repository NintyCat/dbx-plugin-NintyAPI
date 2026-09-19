// Rebuilds the UI bundle whenever a source file changes. Vite's own watch mode
// is not enough here: the DBX dev host wants the post-build inline step to run
// on every rebuild, so this drives full `vite build` runs behind a debounce.
import { watch } from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const uiDir = fileURLToPath(new URL('../ui/', import.meta.url))
const vite = uiDir + 'node_modules/vite/bin/vite.js'
const DEBOUNCE_MS = 350

let busy = false
let queued = false
let timer

const runBuild = async () => {
  busy = true
  const child = spawn(process.execPath, [vite, 'build'], { cwd: uiDir, stdio: 'inherit' })
  await new Promise((done) => child.once('exit', done))
  busy = false
  if (queued) {
    queued = false
    await runBuild()
  }
}

const schedule = () => {
  clearTimeout(timer)
  timer = setTimeout(() => {
    if (busy) {
      queued = true
      return
    }
    void runBuild()
  }, DEBOUNCE_MS)
}

watch(uiDir + 'src', { recursive: true }, schedule)
for (const file of ['index.html', 'vite.config.ts']) watch(uiDir + file, schedule)
console.log('Watching UI source files; generated assets are excluded.')
