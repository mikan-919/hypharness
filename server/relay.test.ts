import { expect, test } from 'bun:test'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'
import type { Usage } from '../shared/dialog.ts'
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
