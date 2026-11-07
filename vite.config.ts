import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite-plus'
import { irisoutHono } from 'irisout/hono/vite'
import { app, boot } from './server/app.ts'

// irisoutHono は開発時にページの GET だけを Hono へ渡す。API は要求と応答の本文をそのまま中継し、SSE を流し続ける
const honoDevelopment = {
  name: 'hono-development',
  configureServer(server) {
    boot()
    server.middlewares.use(async (request, response, next) => {
      if (!request.url?.startsWith('/api/')) return next()
      try {
        const body = request.method === 'GET' ? undefined : (Readable.toWeb(request) as unknown as ReadableStream)
        const result = await app.fetch(
          new Request(new URL(request.url, 'http://localhost'), {
            method: request.method,
            headers: request.headers as Record<string, string>,
            body,
            duplex: 'half',
          } as RequestInit),
        )
        response.statusCode = result.status
        result.headers.forEach((value, name) => response.setHeader(name, value))
        if (!result.body) return response.end()
        const stream = Readable.fromWeb(result.body as any)
        request.on('close', () => stream.destroy())
        stream.pipe(response)
      } catch (error) {
        next(error)
      }
    })
  },
}

// ponytail: irisoutHono 0.3.7 は /irisout-client.js を要求の書き換えだけで配信し、HTML の事前変換で解決できずに警告が出る。irisout が直ったら外す（mikan-919/irisout#5）
const clientAlias = {
  name: 'irisout-client-alias',
  apply: 'serve' as const,
  resolveId(id: string) {
    if (id === '/irisout-client.js') return this.resolve('virtual:irisout-routes')
  },
}

export default defineConfig({
  plugins: [irisoutHono(app), honoDevelopment, clientAlias],
  // ponytail: irisout は相対 import を仮想 module から解決できず、動的 import も断る。Monaco を遅く読む小さな module だけを別名で Vite に渡す
  resolve: { alias: { 'hyph-monaco': fileURLToPath(new URL('./routes/monaco.mjs', import.meta.url)) } },
  build: { rollupOptions: { input: {} } },
})
