import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// Dev: the page runs on :5190 and forwards /api to the server on :5300.
// Build: the page is written into server/public, and the server serves it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5190, host: true, proxy: { '/api': 'http://localhost:5300' } },
  build: { outDir: '../server/public', emptyOutDir: true },
})
