import { defineConfig } from 'vite'

const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
}

function inactiveCloud({ middlewares }) {
  middlewares.use((request, response, next) => {
    const path = request.url?.split('?')[0]
    if (path === '/api/engine/status' && ['GET', 'HEAD'].includes(request.method)) {
      request.url = '/cloud-status.json'
      response.setHeader('Cache-Control', 'no-store')
    } else if (path === '/api/engine/analyze' || path?.startsWith('/api/engine/analyze/')) {
      response.writeHead(503, { 'Cache-Control': 'no-store' })
      response.end()
      return
    }
    next()
  })
}

export default defineConfig({
  plugins: [{ name: 'inactive-cloud', configureServer: inactiveCloud, configurePreviewServer: inactiveCloud }],
  server: { headers }, preview: { headers },
})
