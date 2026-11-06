import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createFileRouter } from 'irisout/hono'
import { fixture } from '../shared/fixture.ts'
import type { Usage } from '../shared/dialog.ts'

export const app = new Hono()

// ponytail: 中継ができるまでの見本。本物は固定部の中継が呼び出しごとの数を流す（ADR 0016）
app.get('/api/usage', (c) =>
  streamSSE(c, async (stream) => {
    const topics = fixture.topics.filter((t) => t.state !== 'ready')
    while (!stream.aborted) {
      const topic = topics[Math.floor(Math.random() * topics.length)]
      const usage: Usage = {
        topicId: topic.id,
        input: 0,
        output: 1 + Math.floor(Math.random() * 8),
        cacheRead: 0,
        costUsd: 0.000002,
      }
      await stream.writeSSE({ data: JSON.stringify(usage) })
      await stream.sleep(80)
    }
  }),
)

app.get('/style.css', async (c) => {
  c.header('content-type', 'text/css')
  return c.body(await Bun.file(new URL('../routes/style.css', import.meta.url)).text())
})

app.route(
  '/',
  createFileRouter('./routes', {
    loaders: { '/': () => fixture },
  }),
)
