import { expect, test } from 'bun:test'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { Usage } from '../shared/dialog.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { relayCall } from '../harness/topic.ts'
import { createRelay } from './relay.ts'

const message = (output: number, cost: number) =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: 'こんにちは' }],
    usage: { input: 10, output, cacheRead: 2, cacheWrite: 0, cost: { total: cost } },
    stopReason: 'stop',
  }) as unknown as AssistantMessage

const fake = (output: number, cost: number) =>
  async function* (): AsyncIterable<AssistantMessageEvent> {
    const partial = message(0, 0)
    yield { type: 'text_delta', contentIndex: 0, delta: 'こんにちは、世界', partial }
    yield { type: 'text_delta', contentIndex: 0, delta: 'です', partial }
    yield { type: 'done', reason: 'stop', message: message(output, cost) }
  }

const post = (relay: ReturnType<typeof createRelay>, taskId: string) =>
  relay.handle(
    new Request('http://relay/', {
      method: 'POST',
      body: JSON.stringify({ topicId: 'ui', taskId, context: { messages: [] } }),
    }),
  )

test('合計はストリーミング中は見積もりで増え、完了時に実際の数に置き換わり、呼び出しをまたいで足される', async () => {
  const relay = createRelay(fake(7, 0.01), 1)
  const seen: Record<string, Usage>[] = []
  relay.subscribe((totals) => seen.push(totals))
  const lines = (await (await post(relay, 't1')).text()).trim().split('\n').map((line) => JSON.parse(line))
  expect(lines.map((event) => event.type)).toEqual(['text_delta', 'text_delta', 'done'])
  expect(lines[0].partial).toBeUndefined()
  // こんにちは、世界 は8文字、です は2文字。1文字 1.1 で見積もる
  expect(seen.map((t) => t.ui.output)).toEqual([9, 11, 7])
  expect(seen.at(-1)?.ui).toMatchObject({ input: 10, output: 7, cacheRead: 2, costUsd: 0.01 })
  await (await post(relay, 't1')).text()
  expect(relay.totals().ui).toMatchObject({ input: 20, output: 14 })
})

test('課題が上限に達したら、どの課題の呼び出しも断る', async () => {
  const relay = createRelay(fake(7, 0.6), 1)
  expect((await (await post(relay, 't1')).text()).length).toBeGreaterThan(0)
  expect(relay.halted()).toBe('')
  await (await post(relay, 't1')).text()
  expect(relay.halted()).toContain('t1')
  expect((await post(relay, 't2')).status).toBe(423)
})

test('停止を解くと、また呼び出しを受け付け、停止の理由は空になる', async () => {
  const relay = createRelay(fake(7, 0.6), 1)
  await (await post(relay, 't1')).text()
  await (await post(relay, 't1')).text()
  expect((await post(relay, 't2')).status).toBe(423)
  relay.resume()
  expect(relay.halted()).toBe('')
  expect((await post(relay, 't2')).status).not.toBe(423)
})

test('形の違う要求は断る', async () => {
  const relay = createRelay(fake(1, 0), 1)
  const response = await relay.handle(new Request('http://relay/', { method: 'POST', body: '{}' }))
  expect(response.status).toBe(400)
})

test('最初のトークンまで 10 秒以上かかっても、Unix ソケットの接続が切れない', async () => {
  const slow = async function* (): AsyncIterable<AssistantMessageEvent> {
    await Bun.sleep(25_000)
    yield { type: 'done', reason: 'stop', message: message(3, 0.001) }
  }
  const relay = createRelay(slow, 1)
  const socket = join(mkdtempSync(join(tmpdir(), 'hyph-relay-')), 'relay.sock')
  const server = relay.listen(socket)
  const reply = await relayCall(socket)({ topicId: 'ui', taskId: 't1', context: { messages: [] } })
  server.stop(true)
  expect(reply.usage.output).toBe(3)
}, 60_000)

const postCost = (relay: ReturnType<typeof createRelay>, body: unknown) =>
  relay.handle(new Request('http://relay/cost', { method: 'POST', body: JSON.stringify(body) }))

test('モデル以外の費用を /cost で受け取り、課題の費用に足す', async () => {
  const relay = createRelay(fake(1, 0), 1)
  expect((await postCost(relay, { taskId: 't1', costUsd: 0.005 })).status).toBe(200)
  expect(relay.spent('t1')).toBe(0.005)
  await postCost(relay, { taskId: 't1', costUsd: 0.005 })
  expect(relay.spent('t1')).toBeCloseTo(0.01)
})

test('モデル以外の費用でも上限に達したら止め、モデルの呼び出しも断る', async () => {
  const relay = createRelay(fake(1, 0), 1)
  await postCost(relay, { taskId: 't1', costUsd: 0.6 })
  expect(relay.halted()).toBe('')
  await postCost(relay, { taskId: 't1', costUsd: 0.6 })
  expect(relay.halted()).toContain('t1')
  expect((await post(relay, 't1')).status).toBe(423)
})

test('費用の要求の形が違うときは断る', async () => {
  const relay = createRelay(fake(1, 0), 1)
  expect((await postCost(relay, { costUsd: 0.005 })).status).toBe(400)
  expect((await postCost(relay, { taskId: 't1' })).status).toBe(400)
  expect((await postCost(relay, { taskId: 't1', costUsd: -0.005 })).status).toBe(400)
  expect((await postCost(relay, { taskId: 't1', costUsd: '0.005' })).status).toBe(400)
  expect(relay.spent('t1')).toBe(0)
})

test('課題ごとに、呼び出しの回数・トークン数・最大の文脈・edit_context・作り直しを数える', async () => {
  const edit = {
    ...message(3, 0.02),
    content: [{ type: 'toolCall', id: 'e', name: 'edit_context', arguments: { content: '要点' } }],
  } as unknown as AssistantMessage
  const replies = [message(3, 0.01), edit, message(3, 0.01)]
  const relay = createRelay(async function* () {
    yield { type: 'done', reason: 'stop', message: replies.shift()! } as AssistantMessageEvent
  }, 1, (taskId, usage) => seen.push([taskId, usage]))
  const seen: [string, unknown][] = []
  const send = (count: number) =>
    relay
      .handle(
        new Request('http://relay/', {
          method: 'POST',
          body: JSON.stringify({ topicId: 'solve', taskId: 't2', context: { messages: Array(count).fill({ role: 'user', content: 'x' }) } }),
        }),
      )
      .then((r) => r.text())
  await send(3)
  await send(5)
  // edit_context の後は、渡す会話が短くなる
  await send(2)
  expect(seen.at(-1)).toEqual(['t2', { calls: 3, input: 30, cacheRead: 6, output: 9, maxPrompt: 12, edits: 1, rebuilds: 1, costUsd: 0.04 }])
})

test('同じ論点と課題の呼び出しには同じ会話の id を、別の課題には別の id を渡す', async () => {
  const sessions: (string | undefined)[] = []
  const relay = createRelay(async function* (_context, sessionId) {
    sessions.push(sessionId)
    yield { type: 'done', reason: 'stop', message: message(1, 0) } as AssistantMessageEvent
  }, 1)
  const send = (taskId: string) =>
    relay
      .handle(new Request('http://relay/', { method: 'POST', body: JSON.stringify({ topicId: 'solve', taskId, context: { messages: [] } }) }))
      .then((r) => r.text())
  await send('t1')
  await send('t1')
  await send('t2')
  expect(sessions[0]).toMatch(/^hypharness-\w+-solve-t1$/)
  expect(sessions[1]).toBe(sessions[0])
  expect(sessions[2]).not.toBe(sessions[0])
})

test('総利用トークン数は、呼び出しごとの文脈の全体（キャッシュを含む）を足していく', async () => {
  const usages = [
    { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
    // 2回目は前の 10 をキャッシュから読み、新しい 10 のうち 2 を書き込む
    { input: 8, output: 0, cacheRead: 10, cacheWrite: 2 },
  ]
  const relay = createRelay(async function* () {
    const usage = { ...usages.shift()!, cost: { total: 0 } }
    yield { type: 'done', reason: 'stop', message: { ...message(0, 0), usage } } as unknown as AssistantMessageEvent
  }, 1)
  for (let i = 0; i < 2; i++) {
    await relay
      .handle(new Request('http://relay/', { method: 'POST', body: JSON.stringify({ topicId: 'solve', taskId: 't1', context: { messages: [] } }) }))
      .then((r) => r.text())
  }
  const u = relay.totals().solve
  expect(u.input + u.cacheRead + u.cacheWrite + u.output).toBe(30)
})

test('応答が終わったら、書いている途中の文を消す', async () => {
  const writing = async function* (): AsyncIterable<AssistantMessageEvent> {
    yield { type: 'text_delta', delta: '考えている' } as AssistantMessageEvent
    yield { type: 'done', reason: 'stop', message: message(3, 0.001) }
  }
  const socket = join(mkdtempSync(join(tmpdir(), 'hyph-relay-')), 'relay.sock')
  const server = createRelay(writing, 1).listen(socket)
  const seen: string[] = []
  await relayCall(socket, (_, text) => seen.push(text))({ topicId: 'goal', taskId: 't1', context: { messages: [] } })
  server.stop(true)
  expect(seen).toEqual(['考えている', ''])
})
