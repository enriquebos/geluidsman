import { randomUUID } from 'node:crypto'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  const buildId = command === 'build' ? randomUUID() : 'development'
  return {
    define: { __FRONTEND_BUILD_ID__: JSON.stringify(buildId) },
    plugins: [react(), {
      name: 'frontend-build-identity',
      generateBundle(_, bundle) {
        const assets = Object.keys(bundle).filter(name => /^assets\/.+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(name))
        this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build_id: buildId, assets }) })
      },
    }],
    server: { proxy: { '/api': 'http://127.0.0.1:8687' } },
  }
})
