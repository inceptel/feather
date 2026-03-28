import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { readFileSync } from 'fs'

const version = (() => { try { return JSON.parse(readFileSync('../version.json', 'utf8')).version } catch { return new Date().toISOString() } })()

export default defineConfig({
  plugins: [solidPlugin()],
  define: {
    __BUILD_TIME__: JSON.stringify(version),
  },
  base: './',
  build: {
    outDir: '../static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5174,
    proxy: {
      '/new-dev/api': {
        target: 'http://localhost:4870',
        rewrite: (path) => path.replace(/^\/new-dev/, ''),
      },
    },
  },
})
