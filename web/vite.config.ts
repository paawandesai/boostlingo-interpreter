/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const backend = process.env.BACKEND_URL ?? 'http://localhost:5080'

export default defineConfig({
  plugins: [react()],
  server: {
    // The browser only ever talks to the Vite origin; the backend holds every vendor key.
    proxy: {
      '/health': backend,
      '/api': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
