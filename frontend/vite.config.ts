import { defineConfig } from 'vite'
import solidPlugin from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solidPlugin()],
  base: './',
  build: {
    outDir: '../static',
    emptyOutDir: true,
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
