// 手元で動かし、hypharness の Worker から届く依頼を Codex（ChatGPT でのサインイン）で処理する。
// Workers から chatgpt.com へは接続できないため、モデルの呼び出しだけをここで行う
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

const DIR = join(homedir(), '.hyph')
const CONFIG = join(DIR, 'config.json')
const AUTH = join(DIR, 'auth.json')
const MODEL = 'gpt-6.1-sol'
const RECONNECT_MS = 5000

type Config = { url: string; token: string }
type Message = { role: 'user' | 'assistant'; content: string }
type Request = { id: string; instructions: string; messages: Message[] }

const [command, ...args] = process.argv.slice(2)

if (command === 'login') {
  // pi-ai の CLI はカレントディレクトリの auth.json にログイン情報を書く
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  const login = Bun.spawn(
    ['bunx', '@earendil-works/pi-ai', 'login', 'openai'],
    {
      cwd: DIR,
      stdio: ['inherit', 'inherit', 'inherit'],
    },
  )
  process.exit(await login.exited)
} else if (command === 'setup') {
  const [url, token] = args
  if (!url || !token) {
    console.error('使い方: bun run runner setup <URL> <トークン>')
    process.exit(1)
  }
  await mkdir(DIR, { recursive: true, mode: 0o700 })
  await writeJson(CONFIG, { url, token } satisfies Config)
  console.log(`${CONFIG} に保存しました`)
} else if (command === undefined) {
  await start()
} else {
  console.error('使い方: bun run runner [login | setup <URL> <トークン>]')
  process.exit(1)
}

async function start() {
  const config: Config = await Bun.file(CONFIG).json()
  const models = createModels({ credentials: fileStore(AUTH) })
  models.setProvider(openaiProvider())
  if (!(await models.getAuth('openai'))) {
    throw new Error('bun run runner login で ChatGPT にサインインしてください')
  }
  const model = models.getModel('openai', MODEL)
  if (!model) throw new Error(`未対応のモデルです: ${MODEL}`)

  const handle = async (request: Request) => {
    const response = await models.complete(model, {
      systemPrompt: request.instructions,
      messages: request.messages.map((m) => toPiMessage(m, model)),
    })
    if (response.stopReason === 'error') throw new Error(response.errorMessage)
    return response.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
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
        ws.send(JSON.stringify({ id: request.id, text: await handle(request) }))
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

// 過去の応答は Codex 以外のモデルが書いたこともあるため、本文だけの応答として渡す
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
