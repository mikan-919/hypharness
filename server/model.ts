import { chmod, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import type { Stream } from './relay.ts'

const DEEPINFRA_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

// 提供元に送る User-Agent。OpenCode Go の利用条件（ADR 0044）に合わせ、汎用の SDK ではない自分の識別子にする
export const USER_AGENT = 'hypharness/0.1'

// 1回の応答の出力の上限。OpenCode Go の目録の 384,000 のまま送ると予約が大きすぎる
const MAX_TOKENS = 32_768

// PROVIDER で提供元を選ぶ。deepinfra（既定）、opencode-go、opendesign、codex
export function model(): Stream {
  const provider = process.env.PROVIDER
  return provider === 'opencode-go'
    ? opencodeGo()
    : provider === 'opendesign'
      ? opendesign()
      : provider === 'codex'
        ? codex()
        : deepinfra()
}

// サインインの情報の置き場。~/.hyph で bunx @earendil-works/pi-ai login openai を実行すると、ここに書かれる
export const AUTH_FILE = join(homedir(), '.hyph', 'auth.json')

// Codex（ADR 0046）。ChatGPT のサブスクリプションでサインインした OpenAI を、Responses API で呼ぶ。
// モデルは CODEX_MODEL（既定 gpt-6-luna）。sessionId は OpenAI のプロンプトのキャッシュの鍵になる
export function codex(id = process.env.CODEX_MODEL || 'gpt-6-luna', file = AUTH_FILE): Stream {
  const models = createModels({ credentials: fileStore(file) })
  models.setProvider(openaiProvider())
  const chosen = models.getModel('openai', id)
  if (!chosen) throw new Error(`OpenAI に ${id} のモデルがありません`)
  const reasoning = process.env.REASONING
  return async function* (context, sessionId) {
    if (!(await models.getAuth('openai'))) {
      throw new Error(`Codex にサインインしていません。~/.hyph で bunx @earendil-works/pi-ai login openai を実行してください`)
    }
    yield* models.stream(chosen, context, {
      ...(reasoning && { reasoningEffort: reasoning }),
      sessionId,
      identity: { userAgent: { custom: USER_AGENT } },
    } as never)
  }
}

// サインインの情報をファイルに置く。refresh token は更新のたびに入れ替わるため、書き込みを直列にして古い値で上書きしない
function fileStore(path: string): CredentialStore {
  let queue: Promise<unknown> = Promise.resolve()
  const load = async (): Promise<Record<string, Credential>> => ((await Bun.file(path).exists()) ? Bun.file(path).json() : {})
  const serial = <T>(task: () => Promise<T>) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
  const write = async (value: unknown) => {
    const temporary = `${path}.tmp`
    await Bun.write(temporary, JSON.stringify(value, null, 2))
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  }
  return {
    read: async (providerId) => (await load())[providerId],
    list: async () => Object.entries(await load()).map(([providerId, credential]) => ({ providerId, type: credential.type })),
    modify: (providerId, fn) =>
      serial(async () => {
        const all = await load()
        const next = await fn(all[providerId])
        if (next !== undefined) await write({ ...all, [providerId]: next })
        return next ?? all[providerId]
      }),
    delete: (providerId) =>
      serial(async () => {
        const { [providerId]: _, ...rest } = await load()
        await write(rest)
      }),
  }
}

// OpenDesign の API（ADR 0045）。OpenAI Chat Completions の形で呼ぶ。
// 接続先は公開の資料に無く、Console の API キーの画面に出るため、OPENDESIGN_BASE_URL（末尾は /v1）と
// OPENDESIGN_MODEL（その接続先の /v1/models に出る id）を必ず書いてもらう。鍵は OPENDESIGN_API_KEY
// ponytail: 単価は DeepSeek V4.1 Flash の公開の単価で数える。OpenDesign のクレジットの倍率は数えない
export function opendesign(): Stream {
  const baseUrl = process.env.OPENDESIGN_BASE_URL
  const id = process.env.OPENDESIGN_MODEL
  if (!baseUrl || !id) throw new Error('PROVIDER=opendesign には OPENDESIGN_BASE_URL と OPENDESIGN_MODEL が要ります')
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'opendesign',
      auth: { apiKey: envApiKeyAuth('OpenDesign API key', ['OPENDESIGN_API_KEY']) },
      models: [
        {
          id,
          name: id,
          api: 'openai-completions',
          baseUrl: baseUrl.replace(/\/+$/, ''),
          provider: 'opendesign',
          reasoning: true,
          input: ['text'],
          cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: MAX_TOKENS,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
            requiresReasoningContentOnAssistantMessages: true,
          },
        },
      ],
      api: openAICompletionsApi(),
    }),
  )
  const chosen = models.getModel('opendesign', id)
  const reasoning = process.env.REASONING
  return (context) =>
    models.stream(chosen, context, {
      ...(reasoning && { reasoningEffort: reasoning }),
      identity: { userAgent: { custom: USER_AGENT } },
    } as never)
}

// OpenCode Go（ADR 0044）。モデルは OPENCODE_MODEL（既定 deepseek-v4.1-flash）、鍵は OPENCODE_API_KEY。
// 会話ごとに固定した sessionId を、pi-ai が x-opencode-session の見出しにして送る
export function opencodeGo(id = process.env.OPENCODE_MODEL || 'deepseek-v4.1-flash'): Stream {
  const models = createModels()
  models.setProvider(opencodeGoProvider())
  const chosen = models.getModel('opencode-go', id)
  if (!chosen) throw new Error(`OpenCode Go に ${id} のモデルがありません`)
  const reasoning = process.env.REASONING
  return (context, sessionId) =>
    models.stream(chosen, context, {
      ...(reasoning && { reasoningEffort: reasoning }),
      sessionId,
      identity: { userAgent: { custom: USER_AGENT } },
      maxTokens: MAX_TOKENS,
    } as never)
}

export function deepinfra(): Stream {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'deepinfra',
      auth: { apiKey: envApiKeyAuth('DeepInfra API key', ['DEEPINFRA_API_KEY']) },
      models: [
        {
          id: DEEPINFRA_ID,
          name: 'DeepSeek V4.1 Flash 1017',
          api: 'openai-completions',
          baseUrl: 'https://api.deepinfra.com/v1/openai',
          provider: 'deepinfra',
          reasoning: true,
          input: ['text'],
          cost: { input: 0.2, output: 0.6, cacheRead: 0.006, cacheWrite: 0 },
          contextWindow: 1_048_576,
          maxTokens: 16_384,
          compat: {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens',
            requiresReasoningContentOnAssistantMessages: true,
          },
        },
      ],
      api: openAICompletionsApi(),
    }),
  )
  const chosen = models.getModel('deepinfra', DEEPINFRA_ID)
  const reasoning = process.env.REASONING
  return (context) => models.stream(chosen, context, { ...(reasoning && { reasoningEffort: reasoning }) } as never)
}
