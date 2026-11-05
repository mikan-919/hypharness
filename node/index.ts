import { chmod, mkdir, rename } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { type Grant, LEASE_MS, type RelayMessage } from '../src/queue'
import { openDeploy } from './deploy'
import { approve, evolutionSummary } from './evolve'
import { openIdeas } from './ideas'
import { openLedger } from './ledger'
import {
  attempt,
  BUDGET_MARGIN,
  checkout,
  DIR,
  models,
  openMeasure,
  withMemory,
} from './measure'
import type { Budget } from './model'
import { loadKey, pack, seal, sha256, unseal } from './vault'

// 旧ランナーの config.json はアカウント単位のトークンで使えないため、別の名前にする
const CONFIG = join(DIR, 'node.json')
const LOGS = join(DIR, 'logs')
const DEFAULT_URL = 'http://localhost:5173'
const PAIRING_POLL_MS = 3000
const RECONNECT_MS = 5000
// 期限の3分の1ごとに更新し、1回の更新が失敗しても期限に間に合わせる
const RENEW_MS = LEASE_MS / 3
// ponytail: チェックポイントは20秒ごとに、作業領域が変わっていたら取る。エージェントの区切りに合わせるなら、エージェントから合図を受ける
const CHECKPOINT_MS = 20_000
const LEDGER_MS = 60_000

type Config = { url: string; token: string }
type Running = { id: number; generation: number; abort: AbortController }

// 使い方: bun run node <セッション> [URL]
// タスクは、セッションの稼働版（一部は試験版）のエージェントで解く
const [session = '', url] = process.argv.slice(2)
const path = join(DIR, 'sessions', `${session}.sqlite`)
// エージェントがタスクをまたいで持つ状態（記憶など）。セッションごとに分ける。
// ponytail: 状態はこのノードにだけ置き、チェックポイントには入れない。別のノードで再開したタスクは、そのノードの状態で続ける。
// ノード間で記憶を揃える必要が出たら、状態の差分を中継経由で配る
const STATE = join(DIR, 'state', session)
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
const ledger = openLedger(m)
// 実際のタスクの費用は目的遂行の区分に記録する
const { solver } = await models((cost) => ledger.record('task', cost))
// 別のノードから配られた計測の試行の費用は、検証の区分に記録する
const { solver: verifier } = await models((cost) =>
  ledger.record('verify', cost),
)
const key = await loadKey(join(DIR, 'vault.key'))
await mkdir(LOGS, { recursive: true, mode: 0o700 })
await mkdir(STATE, { recursive: true, mode: 0o700 })
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
// PR にしている途中の提案の番号
const approving = new Set<number>()
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

// 資源配分の内訳と、このセッションの系統・固定部の変更の提案を、接続時と1分ごとに中継へ送る。
// 計測の命令が別のプロセスで書いた分も含まれる
const report = () => {
  send({ type: 'ledger', rows: ledger.rows() })
  send({ type: 'evolution', session, ...evolutionSummary(m) })
}
setInterval(report, LEDGER_MS)

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
    report()
    if (!running) socket.send(JSON.stringify({ type: 'ready' }))
  }
  socket.onmessage = (event) => {
    const message: RelayMessage = JSON.parse(String(event.data))
    if (message.type === 'task') run(message)
    // 画面で承認された固定部の変更の提案を PR にする。中継は全ノードに送り、処理が終わるまで依頼を送り直すため、
    // 自分のセッションの依頼だけを、同じ提案を重ねずに処理する
    if (
      message.type === 'approve' &&
      message.session === session &&
      !approving.has(message.id)
    ) {
      const id = message.id
      approving.add(id)
      approve(m, id)
        .then((url) => console.log(`提案 #${id} の PR を作りました: ${url}`))
        .catch((e) =>
          console.error(`提案 #${id} を PR にできません: ${e.message}`),
        )
        .finally(() => {
          approving.delete(id)
          report()
        })
    }
    if (
      message.type === 'revoked' &&
      running?.id === message.id &&
      running.generation === message.generation
    ) {
      console.log(`タスク ${message.id} の実行権を失ったため止めます`)
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
  if (task.kind === 'trial') return runTrial(task)
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
  // 作業領域が変わっていたら、暗号化して中継に送る。送れなかったら次の間隔で送り直す
  let work: string | null = null
  let last = ''
  let saving = Promise.resolve()
  const save = async () => {
    if (!work) return
    const data = await pack(work)
    const hash = await sha256(data)
    if (hash === last) return
    const response = await fetch(checkpointUrl(task), {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${config.token}`,
        'content-type': 'application/octet-stream',
      },
      body: await seal(key, String(task.id), data),
    })
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`)
    }
    last = hash
    console.log(
      `タスク ${task.id}: チェックポイントを保存しました（${data.length} バイト）`,
    )
  }
  const timer = setInterval(() => {
    saving = saving
      .then(save)
      .catch((e) =>
        console.error(`チェックポイントを保存できません: ${e.message}`),
      )
  }, CHECKPOINT_MS)
  try {
    // ponytail: 再開したタスクも、版はその時点で選び直す。試験版の比較で版をまたぐタスクが問題になったら、版もチェックポイントに残す
    const restore = task.checkpoint ? await restoreFrom(task) : undefined
    const result = await attempt(
      {
        // 経済のループで採用された方針（記憶）を課題文の前に置く
        statement: withMemory(openIdeas(m).memory(), task.statement),
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
      {
        signal: abort.signal,
        restore,
        onWork: (dir) => {
          work = dir
        },
        state: STATE,
      },
    )
    const ok = task.check === null ? null : result.ok
    console.log(
      `タスク ${task.id}: 終了コード ${result.code}${ok === null ? '' : ok ? '、成功' : '、失敗'}（$${budget.spent.toFixed(4)}）`,
    )
    running = null
    // 判定のあるタスクの成否を、エージェントの状態に置く。次のタスクで、エージェントが使った記憶の評価に反映する
    if (ok !== null && !abort.signal.aborted) {
      await Bun.write(
        join(STATE, 'outcome.json'),
        JSON.stringify({ ok, cost: budget.spent, limit: budget.limit }),
      )
    }
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
  } finally {
    clearInterval(timer)
    await saving
  }
  send({ type: 'ready' })
}

// 別のノードが置いた計測の試行を解く。候補の版は試行の中身で決まり、試験配備の比較やチェックポイントには使わない。
// 実行権が切れたら、別のノードが最初から解き直す
async function runTrial(task: Grant) {
  const abort = new AbortController()
  running = { id: task.id, generation: task.generation, abort }
  console.log(`試行 ${task.id}（世代 ${task.generation}）を解きます`)
  try {
    const { solveTrial } = await import('./trials')
    const r = await solveTrial(task, verifier, abort.signal)
    console.log(`試行 ${task.id}: ${r.ok ? '成功' : '失敗'}`)
    running = null
    if (!abort.signal.aborted) {
      send({
        type: 'done',
        id: task.id,
        generation: task.generation,
        code: r.code ?? 127,
        ok: r.ok,
        version: r.commit,
      })
    }
  } catch (e) {
    running = null
    console.error(e instanceof Error ? e.message : e)
    // 解けなかった試行（中身を読めない・作業領域のディレクトリがない・モデルの障害）も終わったと報告する。
    // 報告しないと期限切れで待ち行列に戻り、同じ失敗を繰り返す。計測する側は結果がないことで失敗を知る。
    // 版は中身を読めないと分からないため、0 を並べた値にする
    if (!abort.signal.aborted) {
      send({
        type: 'done',
        id: task.id,
        generation: task.generation,
        code: 127,
        ok: null,
        version: '0'.repeat(40),
      })
    }
  }
  send({ type: 'ready' })
}

const checkpointUrl = (task: Grant) =>
  `${config.url}/node/checkpoints/${task.id}/${task.generation}`

// 確定チェックポイントを取得し、割り当てに含まれるハッシュと照合してから復号する
async function restoreFrom(task: Grant) {
  const response = await fetch(checkpointUrl(task), {
    headers: { Authorization: `Bearer ${config.token}` },
  })
  if (!response.ok) {
    throw new Error(
      `チェックポイントを取得できません (${response.status}): ${await response.text()}`,
    )
  }
  const blob = new Uint8Array(await response.arrayBuffer())
  if ((await sha256(blob)) !== task.checkpoint) {
    throw new Error('チェックポイントのハッシュが記録と合いません')
  }
  const data = await unseal(key, String(task.id), blob)
  console.log(
    `タスク ${task.id}: チェックポイント ${task.checkpoint?.slice(0, 12)} から再開します`,
  )
  return data
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
