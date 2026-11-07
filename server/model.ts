import { envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import { opencodeGoProvider } from '@earendil-works/pi-ai/providers/opencode-go'
import type { Stream } from './relay.ts'

const DEEPINFRA_ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

// 提供元に送る User-Agent。OpenCode Go の利用条件（ADR 0044）に合わせ、汎用の SDK ではない自分の識別子にする
export const USER_AGENT = 'hypharness/0.1'

// 1回の応答の出力の上限。OpenCode Go の目録の 384,000 のまま送ると予約が大きすぎる
const MAX_TOKENS = 32_768

// PROVIDER で提供元を選ぶ。deepinfra（既定）、opencode-go、opendesign
export function model(): Stream {
  const provider = process.env.PROVIDER
  return provider === 'opencode-go' ? opencodeGo() : provider === 'opendesign' ? opendesign() : deepinfra()
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
