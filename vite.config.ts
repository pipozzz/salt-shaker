import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// In dev, /salt-api is proxied to salt-api (rest_cherrypy) so the browser avoids CORS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: {
      proxy: {
        // the Salt Shaker server (npm run dev:server); without it the UI runs in direct mode
        '/api': { target: env.BACKEND_URL || 'http://localhost:3100', changeOrigin: false },
        '/salt-api': {
          target: env.SALT_API_URL || 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/salt-api/, ''),
        },
      },
    },
  }
})
