import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// Dev: the page runs on :5195 and forwards /api to the server on :5400.
// Build: the page is written into server/public, and the server serves it.
export default defineConfig({
  plugins: [react()],
  server: { port: 5195, host: true, proxy: { '/api': 'http://localhost:5400' } },
  build: { outDir: '../server/public', emptyOutDir: true },
})
