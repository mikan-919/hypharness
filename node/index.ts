import { chmod, mkdir, rename } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { type Grant, LEASE_MS, type RelayMessage } from '../src/queue'
import { openDeploy } from './deploy'
import {
  attempt,
  BUDGET_MARGIN,
  checkout,
  DIR,
  models,
  openMeasure,
} from './measure'
import type { Budget } from './model'

// 旧ランナーの config.json はアカウント単位のトークンで使えないため、別の名前にする
const CONFIG = join(DIR, 'node.json')
const LOGS = join(DIR, 'logs')
const DEFAULT_URL = 'http://localhost:5173'
const PAIRING_POLL_MS = 3000
const RECONNECT_MS = 5000
// 期限の3分の1ごとに更新し、1回の更新が失敗しても期限に間に合わせる
const RENEW_MS = LEASE_MS / 3

type Config = { url: string; token: string }
type Running = { id: number; generation: number; abort: AbortController }

// 使い方: bun run node <セッション> [URL]
// タスクは、セッションの稼働版（一部は試験版）のエージェントで解く
const [session = '', url] = process.argv.slice(2)
const path = join(DIR, 'sessions', `${session}.sqlite`)
if (!/^[\w-]{1,32}$/.test(session) || !(await Bun.file(path).exists())) {
  throw new Error(
    '使い方: bun run node <セッション> [URL]（セッションは bun run measure で作ったもの）',
  )
}
const m = openMeasure(path)
const deploy = openDeploy(m)
if (!deploy.stable() || !m.meta('budget:val')) {
  throw new Error(
    `セッション ${session} に基準版と予算の基準がありません。先に evolve を回してください`,
  )
}
const { solver } = await models()
await mkdir(LOGS, { recursive: true, mode: 0o700 })
const saved: Config | undefined = (await Bun.file(CONFIG).exists())
  ? await Bun.file(CONFIG).json()
  : undefined
// 保存済みと別の URL を指定したときは、そちらとペアリングし直す
const config =
  saved && (url === undefined || url === saved.url)
    ? saved
    : await pair(url ?? DEFAULT_URL)

let ws: WebSocket | null = null
let running: Running | null = null
// 切断中に終わったタスクの報告。再接続したら送る
const unsent: string[] = []

const send = (message: object) => {
  const data = JSON.stringify(message)
  if (ws?.readyState === WebSocket.OPEN) ws.send(data)
  else if ('code' in message) unsent.push(data)
}

// 実行権の更新は、切断中も時刻が来るたびに試みる。再接続して期限内に届けば実行権を持ち続けられる
setInterval(() => {
  if (running) {
    send({ type: 'renew', id: running.id, generation: running.generation })
  }
}, RENEW_MS)

connect()

function connect() {
  const socket = new WebSocket(
    `${config.url.replace(/^http/, 'ws')}/node/socket`,
    { headers: { Authorization: `Bearer ${config.token}` } },
  )
  socket.onopen = () => {
    ws = socket
    console.log(`${config.url} に接続しました`)
    for (const data of unsent.splice(0)) socket.send(data)
    if (!running) socket.send(JSON.stringify({ type: 'ready' }))
  }
  socket.onmessage = (event) => {
    const m: RelayMessage = JSON.parse(String(event.data))
    if (m.type === 'task') run(m)
    if (
      m.type === 'revoked' &&
      running?.id === m.id &&
      running.generation === m.generation
    ) {
      console.log(`タスク ${m.id} の実行権を失ったため止めます`)
      running.abort.abort()
    }
  }
  socket.onclose = (event) => {
    if (ws === socket) ws = null
    console.log(
      `切断されました (${event.code} ${event.reason})。${RECONNECT_MS / 1000}秒後に再接続します`,
    )
    setTimeout(connect, RECONNECT_MS)
  }
}

// タスクを、選んだ版のエージェントに隔離環境で解かせ、判定コマンドがあれば成否を決める。
// 出力はノードの外に出さず、ログに残す。中継に送るのは終了コード・成否・版だけ
async function run(task: Grant) {
  if (running) {
    console.error(`タスク ${running.id} の実行中に別のタスクが届きました`)
    return
  }
  const { version, role } = deploy.pick()
  const abort = new AbortController()
  running = { id: task.id, generation: task.generation, abort }
  const done = (code: number, ok: boolean | null) =>
    send({
      type: 'done',
      id: task.id,
      generation: task.generation,
      code,
      ok,
      version,
    })
  // ponytail: 1タスクの予算は、検証用課題1問あたりの予算と同じにする。実際のタスクの費用が貯まったら、それを基準にする
  const budget: Budget = {
    limit:
      (Number(m.meta('budget:val')) / m.tasks('val').length) * BUDGET_MARGIN,
    spent: 0,
  }
  console.log(
    `タスク ${task.id}（世代 ${task.generation}）を${role === 'canary' ? '試験版' : '稼働版'} ${version.slice(0, 7)} で解きます`,
  )
  try {
    const result = await attempt(
      {
        statement: task.statement,
        files: {},
        check: task.check ?? 'true',
        check_files: {},
        solution: {},
      },
      await checkout(version),
      solver,
      budget,
      () => {},
      join(LOGS, `${task.id}-${task.generation}.log`),
      abort.signal,
    )
    const ok = task.check === null ? null : result.ok
    console.log(
      `タスク ${task.id}: 終了コード ${result.code}${ok === null ? '' : ok ? '、成功' : '、失敗'}（$${budget.spent.toFixed(4)}）`,
    )
    running = null
    if (!abort.signal.aborted) {
      deploy.record(task.id, version, role, ok, budget.spent)
      if (role === 'canary') deploy.decide()
      done(result.code ?? 127, ok)
    }
  } catch (e) {
    running = null
    console.error(e instanceof Error ? e.message : e)
    // モデルの障害では報告しない。実行権の期限が切れると待ち行列に戻り、解き直される。
    // 隔離環境を作れないなどのときは、終了コード 127 で報告して待ち行列を止めない
    if (!budget.outage && !abort.signal.aborted) done(127, null)
  }
  send({ type: 'ready' })
}

// 中継にペアリングを申し込み、利用者がホーム画面でコードを承認したらトークンを受け取って保存する
async function pair(url: string): Promise<Config> {
  const response = await fetch(`${url}/node/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: hostname().slice(0, 64) }),
  })
  if (!response.ok) {
    throw new Error(
      `ペアリングを始められませんでした (${response.status}): ${await response.text()}`,
    )
  }
  const { id, code } = (await response.json()) as { id: string; code: string }
  console.log(
    `${url} にログインし、ホーム画面で次のコードを入力してください: ${code}`,
  )
  while (true) {
    await Bun.sleep(PAIRING_POLL_MS)
    const claim = await fetch(`${url}/node/pairings/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const result = (await claim.json()) as {
      token?: string
      name?: string
      error?: string
    }
    if (result.token) {
      // 意図しないアカウントに紐付いていないか、利用者が確かめられるよう名前を出す
      console.log(`${result.name} のアカウントとペアリングしました`)
      const config = { url, token: result.token }
      await writeJson(CONFIG, config)
      return config
    }
    if (!claim.ok) throw new Error(result.error ?? `${claim.status}`)
  }
}

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから置き換える
async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2))
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
