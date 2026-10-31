// 手元で動かすエージェントの実行環境。Worker から届いた発言を、エージェントごとの記憶と
// Codex（ChatGPT でのサインイン）で処理する。Workers から chatgpt.com へは接続できないため、ここで動かす
import { chmod, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  AssistantMessage,
  Credential,
  CredentialStore,
  Message as PiMessage,
} from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { type Message, openAgent } from './agent'

const DIR = join(homedir(), '.hyph')
const CONFIG = join(DIR, 'config.json')
const AUTH = join(DIR, 'auth.json')
const AGENTS = join(DIR, 'agents')
const MODEL = 'gpt-6.1-sol'
const DEFAULT_URL = 'http://localhost:5173'
const PAIRING_POLL_MS = 3000
const RECONNECT_MS = 5000

type Config = { url: string; token: string }
type Request = { id: string; agent: string; message: string }

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
  const agents = new Map<string, ReturnType<typeof openAgent>>()

  // 応答の差分は届いたそばから onDelta に渡し、全文がそろってから記憶に残す
  const handle = async (request: Request, onDelta: (delta: string) => void) => {
    const agent = agents.get(request.agent) ?? openAgent(AGENTS, request.agent)
    agents.set(request.agent, agent)
    const { instructions, messages } = agent.context(request.message)
    let text = ''
    const events = models.stream(model, {
      systemPrompt: instructions,
      messages: messages.map((m) => toPiMessage(m, model)),
    })
    for await (const event of events) {
      if (event.type === 'text_delta') {
        text += event.delta
        onDelta(event.delta)
      }
      if (event.type === 'error') {
        throw new Error(event.error.errorMessage ?? event.reason)
      }
    }
    agent.remember('user', request.message)
    agent.remember('assistant', text)
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
        await handle(request, (delta) =>
          ws.send(JSON.stringify({ id: request.id, delta })),
        )
        ws.send(JSON.stringify({ id: request.id, done: true }))
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

// 記憶には応答の本文だけを残しているため、本文だけの応答として渡す
function toPiMessage(
  message: Message,
  model: { api: AssistantMessage['api']; provider: string; id: string },
): PiMessage {
  if (message.role === 'user') {
    return { role: 'user', content: message.content, timestamp: Date.now() }
  }
  return {
    role: 'assistant',
    content: [{ type: 'text', text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  }
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
