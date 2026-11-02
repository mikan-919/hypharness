import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { LEASE_MS, type RelayMessage } from '../src/queue'
import { sandbox } from './sandbox'

const DIR = join(homedir(), '.hyph')
// 旧ランナーの config.json はアカウント単位のトークンで使えないため、別の名前にする
const CONFIG = join(DIR, 'node.json')
const WORK = join(DIR, 'work')
const LOGS = join(DIR, 'logs')
const DEFAULT_URL = 'http://localhost:5173'
const PAIRING_POLL_MS = 3000
const RECONNECT_MS = 5000
// 期限の3分の1ごとに更新し、1回の更新が失敗しても期限に間に合わせる
const RENEW_MS = LEASE_MS / 3

type Config = { url: string; token: string }
type Running = { id: number; generation: number; child: Bun.Subprocess }

// 使い方: bun run node [URL]
const [url] = process.argv.slice(2)
await mkdir(DIR, { recursive: true, mode: 0o700 })
await mkdir(WORK, { recursive: true, mode: 0o700 })
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
      running.child.kill()
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

// タスクのコマンドを、タスクごとの作業用ディレクトリで隔離して実行する。
// 出力はノードの外に出さず、ログに残す。中継に送るのは終了コードだけ
async function run(task: { id: number; generation: number; command: string }) {
  if (running) {
    console.error(`タスク ${running.id} の実行中に別のタスクが届きました`)
    return
  }
  const work = await mkdtemp(join(WORK, `${task.id}-`))
  const log = join(LOGS, `${task.id}-${task.generation}.log`)
  try {
    // 標準エラーも同じログに順に残す。隔離環境を作る bwrap 自体のエラーはノードの画面に出る
    const child = Bun.spawn(sandbox(work, `exec 2>&1\n${task.command}`), {
      stdout: Bun.file(log),
      stderr: 'inherit',
    })
    running = { ...task, child }
    console.log(`タスク ${task.id}（世代 ${task.generation}）: ${task.command}`)
    const code = await child.exited
    console.log(`タスク ${task.id} が終了コード ${code} で終わりました`)
    running = null
    send({ type: 'done', id: task.id, generation: task.generation, code })
  } catch (e) {
    // 隔離環境を作れないときも、終了コード 127 で報告して待ち行列を止めない
    console.error(e instanceof Error ? e.message : e)
    running = null
    send({ type: 'done', id: task.id, generation: task.generation, code: 127 })
  } finally {
    await rm(work, { recursive: true, force: true })
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
