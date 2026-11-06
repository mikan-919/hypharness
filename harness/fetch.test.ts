import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { createStore } from '../server/store.ts'
import { deps, webFetch } from './fetch.ts'
import { type Call, runTopic, TOOLS } from './topic.ts'

const real = { fetch: deps.fetch, lookup: deps.lookup, now: deps.now }
let clock = 0

// fetch と名前解決を差し替え、呼ばれた URL を返す
const fake = (handler: (url: string) => Response | Promise<Response>, addresses: Record<string, string[]> = {}) => {
  clock = 0
  const calls: string[] = []
  deps.fetch = (async (input: any) => {
    calls.push(String(input))
    return handler(String(input))
  }) as typeof fetch
  deps.lookup = async (host: string) => addresses[host] ?? ['93.184.216.34']
  deps.now = () => clock
  return calls
}

const restore = () => {
  deps.fetch = real.fetch
  deps.lookup = real.lookup
  deps.now = real.now
}

const reply = (name: string, args: object) => ({ role: 'assistant', content: [{ type: 'toolCall', id: name, name, arguments: args }] }) as unknown as AssistantMessage

test('file: と ftp: の URL は取得せずに断る', async () => {
  const calls = fake(() => new Response('x', { headers: { 'content-type': 'text/plain' } }))
  try {
    await expect(webFetch('file:///etc/passwd')).rejects.toThrow('http')
    await expect(webFetch('ftp://example.com/a')).rejects.toThrow('http')
    expect(calls).toEqual([])
  } finally {
    restore()
  }
})

test('127.0.0.1 と、192.168.1.1 に解決されるホスト名は取得しない', async () => {
  const calls = fake(() => new Response('x', { headers: { 'content-type': 'text/plain' } }), { 'internal.example': ['192.168.1.1'] })
  try {
    await expect(webFetch('https://127.0.0.1/a')).rejects.toThrow('内部を指す宛先')
    await expect(webFetch('https://internal.example/a')).rejects.toThrow('内部を指す宛先')
    expect(calls).toEqual([])
  } finally {
    restore()
  }
})

test('HTML からタグと script・style を除いた本文を返し、max_chars で切る', async () => {
  const html =
    '<html><head><style>p { color: red }</style><script>var a = 1</script></head><body><h1>T</h1>\n\n <p>本文 です</p></body></html>'
  fake(() => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
  try {
    expect(await webFetch('https://a.example/html')).toBe('T 本文 です')
    expect(await webFetch('https://b.example/html', 3)).toBe('T 本')
  } finally {
    restore()
  }
})

test('text でない Content-Type は例外にする', async () => {
  fake(() => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  try {
    await expect(webFetch('https://c.example/json')).rejects.toThrow('application/json')
  } finally {
    restore()
  }
})

test('HTTP 500 は例外になり、runTopic では web_fetch の isError の結果になって対話が続く', async () => {
  fake(() => new Response('boom', { status: 500 }))
  const repo = mkdtempSync(join(tmpdir(), 'hyph-'))
  try {
    await expect(webFetch('https://d.example/fail')).rejects.toThrow('500')
    const store = createStore()
    store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
    const replies = [
      reply('web_fetch', { url: 'https://e.example/fail' }),
      reply('write_doc', { path: 'docs/adr/0001-x.md', content: '# 0001 x' }),
      reply('ready', {}),
    ]
    const call: Call = async () => replies.shift()!
    await runTopic(store, call, 'goal', repo)
    const result = store
      .transcript('goal')!
      .filter((m: any) => m.role === 'toolResult' && m.toolName === 'web_fetch')
      .at(-1) as any
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toContain('500')
    expect(store.snapshot().topics[0].ready).toBe(true)
  } finally {
    restore()
  }
})

test('同じ URL の応答は 1 時間だけ持ち、過ぎたら取り直す', async () => {
  const calls = fake(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }))
  try {
    expect(await webFetch('https://f.example/cache')).toBe('ok')
    expect(await webFetch('https://f.example/cache')).toBe('ok')
    expect(calls.length).toBe(1)
    clock = 3_600_001
    expect(await webFetch('https://f.example/cache')).toBe('ok')
    expect(calls.length).toBe(2)
  } finally {
    restore()
  }
})

test('TOOLS() の一覧には、PARALLEL_API_KEY の有無に関わらず web_fetch が入る', () => {
  const saved = process.env.PARALLEL_API_KEY
  try {
    delete process.env.PARALLEL_API_KEY
    expect(TOOLS().map((t) => t.name)).toContain('web_fetch')
    process.env.PARALLEL_API_KEY = 'test-key'
    expect(TOOLS().map((t) => t.name)).toContain('web_fetch')
  } finally {
    if (saved === undefined) delete process.env.PARALLEL_API_KEY
    else process.env.PARALLEL_API_KEY = saved
  }
})
