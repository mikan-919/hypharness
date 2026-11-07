import { unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { createFileRouter } from 'irisout/hono'
import { startDialog } from './dialog.ts'
import { serveHost } from './host.ts'
import { model } from './model.ts'
import { runPipeline } from './pipeline.ts'
import { createRelay } from './relay.ts'
import { createStore } from './store.ts'
import { weaknesses } from './evolve/round.ts'
import { runEvolve } from './evolve/run.ts'
import { listArchive, listCandidates } from './evolve/store.ts'
import { createWorkers } from './workers.ts'

// Vite の開発サーバーには Bun が .env を読み込まないため、ここで読む。既にある環境変数は上書きしない
try {
  process.loadEnvFile('.env')
} catch {}

// プロセスごとに分け、別に起動したサーバーとソケットを取り合わない
const RELAY_SOCKET = join(homedir(), '.hyph', `relay-${process.pid}.sock`)
// 子プロセスとして動く改良の対象が、対話の状態に触れる受け口（ADR 0022）
const HOST_SOCKET = join(homedir(), '.hyph', `host-${process.pid}.sock`)
const REPO = process.env.TARGET_REPO ?? process.cwd()

// 開発サーバーは server/app.ts が変わるたびに同じプロセスでこのファイルを読み直す。
// 中継・対話の状態・論点エージェントが二重にならないよう、プロセスに1つだけ置く
const shared = ((globalThis as any).__hypharness ??= {
  relay: createRelay(model(), Number(process.env.TASK_LIMIT_USD ?? 1), (taskId, usage) => {
    // 分解役の呼び出しは課題を足す前に来る。課題が足された後の呼び出しで、それまでの分もまとめて入る
    if (shared.store.snapshot().tasks.some((t) => t.id === taskId)) shared.store.setTask(taskId, { usage })
  }),
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
  for (const socket of [RELAY_SOCKET, HOST_SOCKET]) {
    try {
      unlinkSync(socket)
    } catch {}
  }
  relay.listen(RELAY_SOCKET)
  serveHost(store, HOST_SOCKET)
  dialog()
  // 前の起動で流れが動いていたら、止まった所から続ける。課題ごとの費用は前の起動の分から数える
  const { started, finished, tasks } = store.snapshot()
  if (started) {
    for (const t of tasks) if (t.usage) relay.restore(t.id, t.usage)
    store.act('host', 'text', 'サーバーが再起動したため、前の流れの続きから動かす')
    // 最終目的を満たして終えていれば、自己改良の1周の途中で止まった。周は初めからやり直す
    if (finished) void evolve()
    else flow()
  }
  return RELAY_SOCKET
}

// 論点エージェント・分解役・解答役は、hypharness 自身の統合ブランチの先端の版で、子プロセスとして動かす（ADR 0022）
const workers = createWorkers({
  harness: process.cwd(),
  versions: join(homedir(), '.hyph', 'versions'),
  relay: RELAY_SOCKET,
  host: HOST_SOCKET,
  store,
})

// 論点エージェントを動かす。止まっていたら、保存した対話の続きから動かし直せる
function dialog() {
  if (shared.running) return
  shared.running = true
  void startDialog(store, workers.run, REPO).finally(() => {
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

// 開始の合図（ADR 0021）。論点エージェントの過半数が開始可のときだけ受け付ける
app.post('/api/start', (c) => {
  const { topics, started } = store.snapshot()
  if (started) return c.json({ error: '既に動いています' }, 409)
  if (topics.filter((t) => t.ready).length * 2 <= topics.length) {
    return c.json({ error: '論点エージェントの過半数が開始可になっていません' }, 409)
  }
  // 自己改良の弱点は、この流れで起きた失敗だけにする。前の流れの失敗は、その後の課題で直っていることがある
  store.setRun({ from: { tasks: store.snapshot().tasks.length, entries: store.snapshot().entries.length } })
  flow()
  return c.json({ ok: true })
})

// 課題を解く流れを動かし、最終目的を満たして終えたら自己改良の1周を回す。開始の合図と、再起動の後の再開から呼ぶ
function flow() {
  // 費用の上限で止まっていたら、中継の停止を解いてから流れを始める（ADR 0012）
  relay.resume()
  void runPipeline(store, workers.roles, REPO, {
    worktrees: join(homedir(), '.hyph', 'worktrees', REPO.replaceAll('/', '_')),
    setup: process.env.SETUP_COMMAND,
    check: process.env.CHECK_COMMAND,
    spent: relay.spent,
    limitUsd: relay.limitUsd,
  }).then(() => {
    if (store.snapshot().finished) return evolve()
  })
}

// 自己改良の1周（ADR 0014）。分解役が最終目的を満たしたと判断した後に、hypharness 自身の改良の対象を1周改良する。
// 検査に通った候補は統合ブランチに積み、次に動くエージェントから効く（ADR 0022）。回している間は開始の合図を受け付けない
async function evolve() {
  const now = store.snapshot()
  const mark = now.from
  const dialog = { ...now, tasks: now.tasks.slice(mark.tasks), entries: now.entries.slice(mark.entries) }
  if (weaknesses(dialog).length === 0) {
    store.act('evolve', 'text', 'この流れで失敗が無かったため、自己改良の1周を回さなかった')
    return
  }
  store.setRun({ started: true })
  store.act('evolve', 'text', '自己改良の1周を始めた')
  store.setEvolution({ stage: 'proposing', candidates: [], spent: 0 })
  try {
    const result = await runEvolve({
      repo: REPO,
      dialog,
      harness: process.cwd(),
      stream: relay.stream('evolve', `evolve-${Date.now()}`),
      adopt: true,
      store,
      log: (kind, text) => store.act('evolve', kind, text),
      // 周の進みを対話の状態に保存し、画面へ流す
      onProgress: (progress) => store.setEvolution(progress),
    })
    for (const r of result.rejected) store.act('evolve', 'fail', `${r.module}: ${r.reason}`)
    store.act('evolve', 'text', `自己改良の1周 ${result.round} を終えた。費用 ${result.spent.toFixed(4)} ドル`)
  } catch (e) {
    store.act('evolve', 'fail', `自己改良の1周に失敗した: ${(e as Error).message}`)
    store.setEvolution({ stage: 'done' })
  } finally {
    // 周の費用が上限に達して中継が止まっていても、課題の流れは終わっているので解く
    relay.resume()
    store.setRun({ started: false })
  }
}

// 止めるボタン。解いている途中では止めず、今の課題を終えたら止める
app.post('/api/stop', (c) => {
  if (!store.snapshot().started) return c.json({ error: '流れは動いていません' }, 409)
  store.setRun({ stopping: true })
  return c.json({ ok: true })
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
    loaders: {
      '/': () => ({ ...store.snapshot(), evolutionCandidates: [...listCandidates(), ...listArchive()] }),
      '/metrics': () => store.snapshot(),
    },
  }),
)
