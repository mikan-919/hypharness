import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { app, listenRelay, RELAY_SOCKET } from './app.ts'

const serverApp = new Hono()
serverApp.on(['GET', 'HEAD'], '/irisout-client.js', serveStatic({ root: './dist' }))
serverApp.on(['GET', 'HEAD'], '/assets/*', serveStatic({ root: './dist' }))
serverApp.route('/', app)

const server = Bun.serve({
  // このマシンからだけ開く（ADR 0007）
  hostname: '127.0.0.1',
  port: Number(process.env.PORT ?? 4173),
  fetch: serverApp.fetch,
  idleTimeout: 0,
})

listenRelay()
console.log(`http://127.0.0.1:${server.port}`)
console.log(`中継: ${RELAY_SOCKET}`)
