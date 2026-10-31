// 手元で動かすエージェントの実行環境。Worker から届いた発言を、エージェントごとの記憶と
// Codex（ChatGPT でのサインイン）で処理する。Workers から chatgpt.com へは接続できないため、ここで動かす

import { Database } from 'bun:sqlite'
import { chmod, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { openAgent, respond } from './agent'
import { openEconomy } from './economy'
import { startLoops } from './loop'
import { createToolbox, type Toolbox, withTools } from './tools'

const DIR = join(homedir(), '.hyph')
const CONFIG = join(DIR, 'config.json')
const AUTH = join(DIR, 'auth.json')
const AGENTS = join(DIR, 'agents')
const FILES = join(DIR, 'files')
const MODEL = 'gpt-6.1-sol'
const DEFAULT_URL = 'http://localhost:5173'
const PAIRING_POLL_MS = 3000
const RECONNECT_MS = 5000

type Config = { url: string; token: string }
// Worker からの依頼。chat は応答を差分で流し、それ以外は result を1回返す
type Request = { id: string } & (
  | { method: 'chat'; agent: string; message: string }
  | { method: 'status' | 'start' | 'stop' }
  | { method: 'setGoal'; goal: unknown }
)

// 使い方: bun run runner [URL] / bun run runner login
// 初回は ChatGPT へのサインインと、Worker とのペアリングをこのコマンドの中で行う
const [arg] = process.argv.slice(2)
await mkdir(DIR, { recursive: true, mode: 0o700 })
if (arg === 'login') await login()
else await start(arg)

async function login() {
  // pi-ai の CLI はカレントディレクトリの auth.json にログイン情報を書く
  const child = Bun.spawn(
    ['bunx', '@earendil-works/pi-ai', 'login', 'openai'],
    {
      cwd: DIR,
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  )
  if ((await child.exited) !== 0) throw new Error('サインインに失敗しました')
}

// Worker にペアリングを申し込み、利用者がホーム画面でコードを承認したらトークンを受け取って保存する
async function pair(url: string): Promise<Config> {
  const response = await fetch(`${url}/runner/pairings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
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
    const claim = await fetch(`${url}/runner/pairings/claim`, {
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

async function start(url: string | undefined) {
  const models = createModels({ credentials: fileStore(AUTH) })
  models.setProvider(openaiProvider())
  if (!(await models.getAuth('openai'))) await login()
  const model = models.getModel('openai', MODEL)
  if (!model) throw new Error(`未対応のモデルです: ${MODEL}`)

  const saved: Config | undefined = (await Bun.file(CONFIG).exists())
    ? await Bun.file(CONFIG).json()
    : undefined
  // 保存済みと別の URL を指定したときは、そちらとペアリングし直す
  const config =
    saved && (url === undefined || url === saved.url)
      ? saved
      : await pair(url ?? DEFAULT_URL)

  await mkdir(AGENTS, { recursive: true, mode: 0o700 })
  await mkdir(FILES, { recursive: true, mode: 0o700 })
  const shared = new Database(join(DIR, 'state.sqlite'), { strict: true })
  shared.run('PRAGMA journal_mode = WAL')
  const economy = openEconomy(join(DIR, 'economy.sqlite'))
  const agents = new Map<
    string,
    { agent: ReturnType<typeof openAgent>; toolbox: Toolbox }
  >()
  const agentFor = (name: string) => {
    const cached = agents.get(name)
    if (cached) return cached
    const agent = openAgent(AGENTS, name)
    const entry = { agent, toolbox: createToolbox(agent.db, shared, FILES) }
    agents.set(name, entry)
    return entry
  }

  // ループの進み具合。画面が状態を取りに来たときに返す
  const lines: string[] = []
  let loops: ReturnType<typeof startLoops> | null = null
  const log = (line: string) => {
    console.log(line)
    lines.push(`${new Date().toLocaleTimeString('ja-JP')} ${line}`)
    if (lines.length > 200) lines.shift()
  }
  const status = () => ({
    goal: economy.goal(),
    cycle: economy.cycle(),
    running: loops !== null,
    nextSettleAt: loops?.nextSettleAt() ?? null,
    log: lines,
    companies: economy.companies().map((c) => ({
      ...c,
      workers: economy.workersOf(c.id),
      pool: economy.pool(c.id),
    })),
    investors: economy.investors(),
    ideas: economy.latestIdeas(),
    messages: economy.recentMessages(),
  })

  const call = async (request: Request) => {
    switch (request.method) {
      case 'status':
        return status()
      case 'setGoal':
        if (typeof request.goal !== 'string' || !request.goal.trim()) {
          throw new Error('目的を入力してください')
        }
        economy.setGoal(request.goal.trim())
        return status()
      case 'start':
        if (loops) throw new Error('すでにループを回しています')
        if (!economy.goal()) throw new Error('先に目的を設定してください')
        loops = startLoops({
          economy,
          agent: agentFor,
          log,
          ask: (name, prompt, tools) => {
            const { agent, toolbox } = agentFor(name)
            return respond({
              models,
              model,
              agent,
              toolbox: withTools(toolbox, tools),
              message: prompt,
              onDelta: () => {},
            })
          },
          // ファイルが消えていても採点は続ける
          readFile: (path) =>
            agentFor('market')
              .toolbox.run('file_read', { path })
              .catch(() => null),
        })
        return status()
      case 'stop': {
        const current = loops
        if (!current) throw new Error('ループは止まっています')
        loops = null
        // 動いている途中のエージェントを待つと時間がかかるため、待たずに返す
        current.stop()
        return status()
      }
      default:
        throw new Error(`未知の依頼です: ${request.method}`)
    }
  }

  const connect = () => {
    const ws = new WebSocket(
      `${config.url.replace(/^http/, 'ws')}/runner/socket`,
      {
        headers: { Authorization: `Bearer ${config.token}` },
      },
    )
    ws.onopen = () => console.log(`${config.url} に接続しました`)
    ws.onmessage = async (event) => {
      const request: Request = JSON.parse(String(event.data))
      try {
        if (request.method === 'chat') {
          const { agent, toolbox } = agentFor(request.agent)
          await respond({
            models,
            model,
            agent,
            toolbox,
            message: request.message,
            onDelta: (delta) =>
              ws.send(JSON.stringify({ id: request.id, delta })),
          })
          ws.send(JSON.stringify({ id: request.id, done: true }))
        } else {
          ws.send(
            JSON.stringify({ id: request.id, result: await call(request) }),
          )
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        console.error(error)
        ws.send(JSON.stringify({ id: request.id, error }))
      }
    }
    ws.onclose = (event) => {
      console.log(
        `切断されました (${event.code} ${event.reason})。${RECONNECT_MS / 1000}秒後に再接続します`,
      )
      setTimeout(connect, RECONNECT_MS)
    }
  }
  connect()
}

// refresh token は更新のたびに入れ替わるため、書き込みを直列にして古い値で上書きしない
function fileStore(path: string): CredentialStore {
  let queue: Promise<unknown> = Promise.resolve()
  const load = async (): Promise<Record<string, Credential>> =>
    (await Bun.file(path).exists()) ? Bun.file(path).json() : {}
  const serial = <T>(task: () => Promise<T>) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
  return {
    read: async (providerId) => (await load())[providerId],
    list: async () =>
      Object.entries(await load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    modify: (providerId, fn) =>
      serial(async () => {
        const all = await load()
        const next = await fn(all[providerId])
        if (next !== undefined)
          await writeJson(path, { ...all, [providerId]: next })
        return next ?? all[providerId]
      }),
    delete: (providerId) =>
      serial(async () => {
        const { [providerId]: _, ...rest } = await load()
        await writeJson(path, rest)
      }),
  }
}

// 書きかけのファイルを読まれないよう、一時ファイルに書いてから置き換える
async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2))
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
