import { defineConfig } from 'vite-plus'
import { irisoutHono } from 'irisout/hono/vite'
import { app } from './server/app.ts'

export default defineConfig({
  plugins: [irisoutHono(app)],
  build: { rollupOptions: { input: {} } },
})
