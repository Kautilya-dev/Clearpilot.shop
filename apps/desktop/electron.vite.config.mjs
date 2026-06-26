import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import { cpSync, mkdirSync, readdirSync } from 'fs'
import { resolve, join } from 'path'

// externalizeDepsPlugin() doesn't inline local require('./x') or require('../modules/x')
// calls into the bundled out/main/index.js (confirmed empirically twice: stealthManager.js
// in ../modules, then auth-store.js as a same-directory sibling - both stayed unresolved and
// failed at runtime with "Cannot find module"). After each main-process build, copy
// src/modules/ -> out/modules/ AND index.js's sibling helper files in src/main/ -> out/main/
// so require() resolves real files at runtime, matching the same pattern HireGhost's own
// main process already uses for the same reason.
function copyLocalRequiresPlugin() {
  return {
    name: 'copy-local-requires',
    closeBundle() {
      const modulesSrc = resolve('./src/modules')
      const modulesDest = resolve('./out/modules')
      mkdirSync(modulesDest, { recursive: true })
      cpSync(modulesSrc, modulesDest, { recursive: true })

      const mainSrc = resolve('./src/main')
      const mainDest = resolve('./out/main')
      for (const file of readdirSync(mainSrc)) {
        if (file === 'index.js') continue // index.js is the bundled entry, already in out/main
        cpSync(join(mainSrc, file), join(mainDest, file))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyLocalRequiresPlugin()],
    build: {
      rollupOptions: {
        input: 'src/main/index.js'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: 'src/preload/index.js'
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: {
        input: 'src/renderer/index.html'
      }
    },
    plugins: [react()],
    css: {
      postcss: {
        plugins: [tailwindcss(), autoprefixer()]
      }
    }
  }
})
