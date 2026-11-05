import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { openQueue, type Sql } from '../src/queue'
import type { Complete } from './model'
import { type Link, remoteAttempt, solveTrial, trialTiming } from './trials'
import { sha256 } from './vault'

// 中継の代わり。待ち行列は中継と同じ openQueue を使い、R2 の代わりに中身をハッシュで Map に置く
function fakeRelay() {
  const db = new Database(':memory:', { strict: true })
  const sql: Sql = (query, ...params) =>
    db.query(query).all(...params) as never[]
  const queue = openQueue(sql)
  const blobs = new Map<string, Uint8Array>()
  const put = async (request: Request) => {
    const body = new Uint8Array(await request.arrayBuffer())
    const hash = await sha256(body)
    blobs.set(hash, body)
    return hash
  }
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.headers.get('Authorization') !== 'Bearer t') {
        return new Response('トークンが不正です', { status: 401 })
      }
      const parts = new URL(request.url).pathname.split('/').slice(3)
      if (request.method === 'POST' && !parts.length) {
        return Response.json({
          id: queue.add('', null, Date.now(), await put(request)),
        })
      }
      const t = queue.get(Number(parts[0]))
      if (!t) return new Response('なし', { status: 404 })
      if (parts.length === 1) return Response.json(t)
      if (parts[1] === 'result') return new Response(blobs.get(t.result ?? ''))
      if (parts[2] === 'payload')
        return new Response(blobs.get(t.payload ?? ''))
      if (parts[2] === 'result') {
        const ok = queue.result(
          t.id,
          Number(parts[1]),
          'n',
          await put(request),
          Date.now(),
        )
        return ok
          ? Response.json({})
          : new Response('実行権がない', { status: 409 })
      }
      return new Response('なし', { status: 404 })
    },
  })
  return {
    queue,
    blobs,
    url: `http://localhost:${server.port}`,
    stop: () => server.stop(true),
  }
}

const reply = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-responses',
  provider: 'openai',
  model: 'fake',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
  },
  stopReason: 'toolUse',
  timestamp: 0,
})

test('計測の試行は暗号化して中継に置かれ、別のノードが解いた結果と呼び出しの記録を受け取れる', async () => {
  trialTiming.pollMs = 50
  const relay = fakeRelay()
  const key = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const link: Link = { url: relay.url, token: 't', key }
  const complete: Complete = async (context: Context) =>
    context.messages.length === 1
      ? reply([
          {
            type: 'toolCall',
            id: '1',
            name: 'sh',
            arguments: { command: 'echo 42 > answer.txt' },
          },
        ])
      : reply([{ type: 'toolCall', id: 'f', name: 'finish', arguments: {} }])
  try {
    const waiting = remoteAttempt(
      {
        statement: '秘密の課題文 answer.txt に 42',
        files: {},
        check: 'test "$(cat answer.txt)" = 42',
        check_files: {},
        solution: {},
      },
      join(import.meta.dir, '../agent'),
      'c'.repeat(40),
      1,
      link,
    )
    // 別のノードの役。待ち行列から実行権を受け取り、解いて結果を置き、終了を報告する
    let grant = relay.queue.claim('n', Date.now())
    while (!grant) {
      await Bun.sleep(20)
      grant = relay.queue.claim('n', Date.now())
    }
    // 中継に置かれた中身は暗号化されており、課題文を読めない
    const stored = new TextDecoder().decode(
      relay.blobs.get(grant.payload ?? ''),
    )
    expect(stored).not.toContain('秘密の課題文')
    const r = await solveTrial(
      grant,
      complete,
      new AbortController().signal,
      link,
    )
    expect(r).toEqual({ ok: true, code: 0, commit: 'c'.repeat(40) })
    relay.queue.finish(
      grant.id,
      grant.generation,
      'n',
      { code: 0, ok: true, version: r.commit },
      Date.now(),
    )
    const result = await waiting
    expect(result.ok).toBe(true)
    expect(result.cost).toBeGreaterThan(0)
    expect(result.calls.length).toBeGreaterThanOrEqual(2)
  } finally {
    relay.stop()
  }
}, 120_000)
