import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Writes sw.js at build time with the exact list of files in this build, so once the page has loaded once it opens
 * again without the server (and a new build replaces the old files as a whole).
 */
function offlineShell(): Plugin {
  return {
    name: 'chatterly-offline-shell',
    apply: 'build',
    generateBundle(_o, bundle) {
      const files = ['./', ...Object.keys(bundle).filter((f) => f !== 'sw.js'), 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']
      const id = createHash('sha1').update(files.join('|') + Object.values(bundle).map((b) => (b.type === 'chunk' ? b.code.length : String(b.source).length)).join(',')).digest('hex').slice(0, 10)
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: `const CACHE = 'chatterly-${id}'
const FILES = ${JSON.stringify(files)}
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('chatterly-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    // The page itself: the server's copy when reachable (so updates arrive), otherwise the saved one.
    e.respondWith(fetch(req).catch(() => caches.match('./', { ignoreSearch: true, ignoreVary: true })))
    return
  }
  e.respondWith(caches.match(req, { ignoreSearch: true, ignoreVary: true }).then((hit) => hit || fetch(req)))
})
`
      })
    }
  }
}

const { version } = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  root: resolve('src/renderer'),
  base: './',
  plugins: [react(), offlineShell()],
  resolve: { alias: { '@shared': resolve('src/shared') } },
  worker: { format: 'es' },
  build: { outDir: resolve('dist'), emptyOutDir: true, target: 'es2022' },
  server: { host: '127.0.0.1', port: 5173 }
})
