import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
const files = (await readdir('dist', { recursive: true, withFileTypes: true }))
  .filter(file => file.isFile() && file.name !== 'sw.js')
  .map(file => '/' + file.parentPath.replace(/^dist\/?/, '') + (file.parentPath === 'dist' ? '' : '/') + file.name)
  .sort()
const hash = createHash('sha256')
for (const file of files) hash.update(file).update(await readFile('dist' + file))
const version = 'chessmind-' + hash.digest('hex').slice(0, 16)
await writeFile('dist/sw.js', `
const version = ${JSON.stringify(version)}
const files = new Set(${JSON.stringify(files)})
self.addEventListener('install', event => {
  event.waitUntil(caches.open(version).then(cache => cache.addAll([...files])))
})
self.addEventListener('message', event => {
  if (event.data === 'activate-update') self.skipWaiting()
})
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('chessmind-') && key !== version).map(key => caches.delete(key)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return
  const path = event.request.mode === 'navigate' ? '/index.html' : url.pathname
  if (files.has(path)) event.respondWith(caches.open(version).then(cache => cache.match(path)).then(response => response || fetch(event.request)))
})
`)
