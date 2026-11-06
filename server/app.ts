import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createFileRouter } from 'irisout/hono'
import { startDialog } from '../harness/index.ts'
import { createStore } from '../harness/store.ts'
import { relayCall } from '../harness/topic.ts'
import { deepinfra } from './model.ts'
import { createRelay } from './relay.ts'

// Vite の開発サーバーには Bun が .env を読み込まないため、ここで読む。既にある環境変数は上書きしない
try {
  process.loadEnvFile('.env')
} catch {}

export const relay = createRelay(deepinfra(), Number(process.env.TASK_LIMIT_USD ?? 1))
const RELAY_SOCKET = join(homedir(), '.hyph', 'relay.sock')
const REPO = process.env.TARGET_REPO ?? process.cwd()
// 対話は対象のリポジトリごとに1つ保存する
const store = createStore(
  join(homedir(), '.hyph', 'dialogs', `${REPO.replaceAll('/', '_')}.json`),
  join(REPO, 'FINAL_GOAL.md'),
)

// 中継を開き、対話を始める。待受は起動ファイルと開発サーバーから呼ぶ（Vite の設定の読み込みでは開かない）
export function boot() {
  try {
    unlinkSync(RELAY_SOCKET)
  } catch {}
  relay.listen(RELAY_SOCKET)
  void startDialog(store, relayCall(RELAY_SOCKET), REPO)
  return RELAY_SOCKET
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

app.get('/api/dialog', (c) =>
  streamSSE(c, async (stream) => {
    const send = (dialog: unknown) => void stream.writeSSE({ data: JSON.stringify(dialog) })
    send(store.snapshot())
    stream.onAbort(store.subscribe(send))
    while (!stream.aborted) await stream.sleep(15_000)
  }),
)

// 利用者の本文の書き換え。読んだ版の後に書き換えがあれば 409 で最新の本文を返す（ADR 0018）
app.post('/api/goal', async (c) => {
  const { text, version } = await c.req.json<{ text: string; version: number }>()
  const result = store.editGoal(text, version, 'user', '画面で書き換えた')
  return c.json(result, result.ok ? 200 : 409)
})

app.post('/api/revert', async (c) => {
  const { id } = await c.req.json<{ id: string }>()
  const result = store.revert(id)
  return c.json(result, result.ok ? 200 : 404)
})

app.post('/api/answer', async (c) => {
  const { id, text } = await c.req.json<{ id: string; text: string }>()
  return store.answer(id, text) ? c.json({ ok: true }) : c.json({ error: '答えを受け付けない質問です' }, 409)
})

app.route(
  '/',
  createFileRouter('./routes', {
    loaders: { '/': () => store.snapshot() },
  }),
)
