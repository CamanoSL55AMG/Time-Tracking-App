import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react-swc'
import { execSync } from 'node:child_process'

// Build id for the "New version available" bar (src/components/NewVersionBanner.tsx):
// baked into the page and written to version.json next to index.html. When the
// server has been updated, the two differ and the bar offers Reload.
const BUILD_ID = (() => {
  let commit = ''
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    // no git: the build time alone still changes on every build
  }
  return `${commit || 'build'}-${Date.now().toString(36)}`
})()
const versionFile: Plugin = {
  name: 'version-file',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) + '\n' })
  },
}

// Dev: the page runs on :5195 and forwards /api to the server on :5400.
// Build: the page is written into server/public, and the server serves it.
// allowedHosts: phones reach the dev page through the Cloudflare tunnel
// (https://time.morgansound-dev.com); Vite refuses unknown host names otherwise.
export default defineConfig({
  plugins: [react(), versionFile],
  define: { __APP_BUILD__: JSON.stringify(BUILD_ID) },
  server: {
    port: 5195,
    strictPort: true,
    host: true,
    allowedHosts: ['.morgansound-dev.com'],
    proxy: { '/api': 'http://localhost:5400' },
  },
  build: { outDir: '../server/public', emptyOutDir: true },
})
