import { Readable } from 'node:stream'
import { defineConfig } from 'vite-plus'
import { irisoutHono } from 'irisout/hono/vite'
import { app } from './server/app.ts'

// irisoutHono は開発時にページの GET だけを Hono へ渡す。API は SSE を流し続けられるよう本文をそのまま中継する
const honoDevelopment = {
  name: 'hono-development',
  configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/api/')) return next()
      try {
        const result = await app.fetch(new Request(new URL(request.url, 'http://localhost')))
        response.statusCode = result.status
        result.headers.forEach((value, name) => response.setHeader(name, value))
        if (!result.body) return response.end()
        const body = Readable.fromWeb(result.body as any)
        request.on('close', () => body.destroy())
        body.pipe(response)
      } catch (error) {
        next(error)
      }
    })
  },
}

// ponytail: irisoutHono 0.3.7 は /irisout-client.js を要求の書き換えだけで配信し、HTML の事前変換で解決できずに警告が出る。irisout が直ったら外す
const clientAlias = {
  name: 'irisout-client-alias',
  apply: 'serve' as const,
  resolveId(id: string) {
    if (id === '/irisout-client.js') return this.resolve('virtual:irisout-routes')
  },
}

export default defineConfig({
  plugins: [irisoutHono(app), honoDevelopment, clientAlias],
  build: { rollupOptions: { input: {} } },
})
