import { expect, test } from 'bun:test'
import { opencodeGo, opendesign } from './model.ts'

test('OpenCode Go には、自分の User-Agent と会話ごとの x-opencode-session を付けて送る', async () => {
  const seen: { url: string; headers: Headers; body: any }[] = []
  const original = globalThis.fetch
  process.env.OPENCODE_API_KEY = 'test-key'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, headers: request.headers, body: await request.json() })
    return new Response('{"error":{"message":"止める"}}', { status: 400, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    const stream = opencodeGo('deepseek-v4.1-flash')
    for await (const _ of stream({ systemPrompt: 'システム', messages: [{ role: 'user', content: 'こんにちは', timestamp: 0 }], tools: [] }, 'hypharness-ab12-solve-t3')) {
    }
  } finally {
    globalThis.fetch = original
  }
  expect(seen[0].url).toBe('https://opencode.ai/inference/go/openai/v1/chat/completions')
  expect(seen[0].headers.get('authorization')).toBe('Bearer test-key')
  expect(seen[0].headers.get('user-agent')).toBe('hypharness/0.1')
  expect(seen[0].headers.get('x-opencode-session')).toBe('hypharness-ab12-solve-t3')
  expect(seen[0].body.model).toBe('deepseek-v4.1-flash')
  expect(seen[0].body.max_tokens).toBe(32_768)
})

test('OpenDesign には、Console に出る接続先とモデルで、自分の User-Agent を付けて送る', async () => {
  const seen: { url: string; headers: Headers; body: any }[] = []
  const original = globalThis.fetch
  Object.assign(process.env, { OPENDESIGN_API_KEY: 'od-key', OPENDESIGN_BASE_URL: 'https://example.invalid/v1/', OPENDESIGN_MODEL: 'deepseek-v4.1-flash' })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push({ url: request.url, headers: request.headers, body: await request.json() })
    return new Response('{"error":{"message":"止める"}}', { status: 400, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  try {
    for await (const _ of opendesign()({ systemPrompt: 'システム', messages: [{ role: 'user', content: 'こんにちは', timestamp: 0 }], tools: [] })) {
    }
  } finally {
    globalThis.fetch = original
  }
  expect(seen[0].url).toBe('https://example.invalid/v1/chat/completions')
  expect(seen[0].headers.get('authorization')).toBe('Bearer od-key')
  expect(seen[0].headers.get('user-agent')).toBe('hypharness/0.1')
  expect(seen[0].body.model).toBe('deepseek-v4.1-flash')
})

test('OpenDesign は、接続先かモデルが無ければ起動の時点で止める', () => {
  const saved = process.env.OPENDESIGN_BASE_URL
  delete process.env.OPENDESIGN_BASE_URL
  try {
    expect(() => opendesign()).toThrow('OPENDESIGN_BASE_URL')
  } finally {
    process.env.OPENDESIGN_BASE_URL = saved
  }
})
