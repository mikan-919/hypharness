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

// プロセスごとに分け、別に起動したサーバーとソケットを取り合わない
const RELAY_SOCKET = join(homedir(), '.hyph', `relay-${process.pid}.sock`)
const REPO = process.env.TARGET_REPO ?? process.cwd()

// 開発サーバーは server/app.ts が変わるたびに同じプロセスでこのファイルを読み直す。
// 中継・対話の状態・論点エージェントが二重にならないよう、プロセスに1つだけ置く
const shared = ((globalThis as any).__hypharness ??= {
  relay: createRelay(deepinfra(), Number(process.env.TASK_LIMIT_USD ?? 1)),
  // 対話は対象のリポジトリごとに1つ保存する
  store: createStore(
    join(homedir(), '.hyph', 'dialogs', `${REPO.replaceAll('/', '_')}.json`),
    join(REPO, 'FINAL_GOAL.md'),
  ),
  booted: false,
  running: false,
}) as { relay: ReturnType<typeof createRelay>; store: ReturnType<typeof createStore>; booted: boolean; running: boolean }
export const relay = shared.relay
const store = shared.store

// 中継を開き、対話を始める。待受は起動ファイルと開発サーバーから呼ぶ（Vite の設定の読み込みでは開かない）
export function boot() {
  if (shared.booted) return RELAY_SOCKET
  shared.booted = true
  try {
    unlinkSync(RELAY_SOCKET)
  } catch {}
  relay.listen(RELAY_SOCKET)
  dialog()
  return RELAY_SOCKET
}

// 論点エージェントを動かす。止まっていたら、保存した対話の続きから動かし直せる
function dialog() {
  if (shared.running) return
  shared.running = true
  void startDialog(store, relayCall(RELAY_SOCKET), REPO).finally(() => {
    shared.running = false
  })
}

export const app = new Hono()

// トークン数はハーネスを経由させず、中継から画面へ直接流す（ADR 0016）
app.get('/api/usage', (c) =>
  streamSSE(c, async (stream) => {
    const send = (totals: unknown) => void stream.writeSSE({ data: JSON.stringify(totals) })
    send(relay.totals())
    const unsubscribe = relay.subscribe(send)
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
  const result = store.answer(id, text)
  if (!result.ok) return c.json({ error: text.trim() ? '答えを受け付けない質問です' : '答えが空です' }, 409)
  // 答えを待つエージェントがいなければ、保存した答えから続きを始める
  if (!result.waiting) dialog()
  return c.json({ ok: true })
})

app.route(
  '/',
  createFileRouter('./routes', {
    loaders: { '/': () => store.snapshot() },
  }),
)
