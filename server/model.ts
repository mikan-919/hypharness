import { envApiKeyAuth } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { createModels, createProvider } from '@earendil-works/pi-ai/models'
import type { Stream } from './relay.ts'

const ID = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

// ponytail: 提供元は DeepInfra だけ。旧実装の Codex（ChatGPT のサインイン）は使うときに足す
export function deepinfra(): Stream {
  const models = createModels()
  models.setProvider(
    createProvider({
      id: 'deepinfra',
      auth: { apiKey: envApiKeyAuth('DeepInfra API key', ['DEEPINFRA_API_KEY']) },
      models: [
        {
          id: ID,
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
  const model = models.getModel('deepinfra', ID)
  const reasoning = process.env.REASONING
  return (context) => models.stream(model, context, { ...(reasoning && { reasoningEffort: reasoning }) } as never)
}
