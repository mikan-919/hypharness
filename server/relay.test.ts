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

test('流したトークン数の合計は、完了時に実際の数に合う', async () => {
  const relay = createRelay(fake(7, 0.01), 1)
  const seen: Usage[] = []
  relay.subscribe((usage) => seen.push(usage))
  const lines = (await (await post(relay, 't1')).text()).trim().split('\n').map((line) => JSON.parse(line))
  expect(lines.map((event) => event.type)).toEqual(['text_delta', 'text_delta', 'done'])
  expect(lines[0].partial).toBeUndefined()
  expect(seen.length).toBe(3)
  expect(seen.reduce((sum, usage) => sum + usage.output, 0)).toBe(7)
  expect(seen.reduce((sum, usage) => sum + usage.input, 0)).toBe(10)
})

test('課題が上限に達したら、どの課題の呼び出しも断る', async () => {
  const relay = createRelay(fake(7, 0.6), 1)
  expect((await (await post(relay, 't1')).text()).length).toBeGreaterThan(0)
  expect(relay.halted()).toBe('')
  await (await post(relay, 't1')).text()
  expect(relay.halted()).toContain('t1')
  expect((await post(relay, 't2')).status).toBe(423)
})

test('形の違う要求は断る', async () => {
  const relay = createRelay(fake(1, 0), 1)
  const response = await relay.handle(new Request('http://relay/', { method: 'POST', body: '{}' }))
  expect(response.status).toBe(400)
})
