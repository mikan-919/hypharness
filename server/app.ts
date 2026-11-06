import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createFileRouter } from 'irisout/hono'
import { fixture } from '../shared/fixture.ts'
import { deepinfra } from './model.ts'
import { createRelay } from './relay.ts'

export const relay = createRelay(deepinfra(), Number(process.env.TASK_LIMIT_USD ?? 1))
export const RELAY_SOCKET = join(homedir(), '.hyph', 'relay.sock')

export function listenRelay() {
  try {
    unlinkSync(RELAY_SOCKET)
  } catch {}
  return relay.listen(RELAY_SOCKET)
}

export const app = new Hono()

// トークン数はハーネスを経由させず、中継から画面へ直接流す（ADR 0016）
app.get('/api/usage', (c) =>
  streamSSE(c, async (stream) => {
    const unsubscribe = relay.subscribe((usage) => void stream.writeSSE({ data: JSON.stringify(usage) }))
    stream.onAbort(unsubscribe)
    while (!stream.aborted) await stream.sleep(15_000)
  }),
)

app.route(
  '/',
  createFileRouter('./routes', {
    loaders: { '/': () => fixture },
  }),
)
