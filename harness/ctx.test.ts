import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createStore } from '../server/store.ts'
import { runAgent } from './agent.ts'
import { ctx } from './ctx.ts'
import type { Call } from './topic.ts'

const message = (text: string): Message => ({ role: 'user', content: text, timestamp: 0 })

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hyph-ctx-'))
  process.env.HYPH_CTX_DIR = dir
})

test('3件追記すると、追記した順に3件返る', () => {
  const store = ctx('goal')
  store.append(message('1件目'))
  store.append(message('2件目'))
  store.append(message('3件目'))
  expect(store.messages().map((m) => (m as any).content)).toEqual(['1件目', '2件目', '3件目'])
})

test('同じルートで開き直しても、3件が残っている', () => {
  const first = ctx('goal')
  first.append(message('1件目'))
  first.append(message('2件目'))
  first.append(message('3件目'))
  expect(ctx('goal').messages().map((m) => (m as any).content)).toEqual(['1件目', '2件目', '3件目'])
})

test('別のエージェントの id では別のファイルになり、互いのメッセージが混ざらない', () => {
  ctx('solve').append(message('解答役'))
  ctx('decompose').append(message('分解役'))
  expect(ctx('solve').messages().map((m) => (m as any).content)).toEqual(['解答役'])
  expect(ctx('decompose').messages().map((m) => (m as any).content)).toEqual(['分解役'])
})

const reply = (name: string, args: object, id = name) =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] }) as unknown as AssistantMessage

test('runAgent はループで増えたメッセージを agent の DB に追記する', async () => {
  const store = createStore()
  const replies = [reply('read_file', { path: 'a' }), reply('done', {})]
  const call: Call = async () => replies.shift()!
  const messages: Message[] = [message('はじめての指示')]
  const summary = await runAgent<string>({
    store,
    call,
    agent: 'solve',
    taskId: 't1',
    system: '',
    tools: [],
    messages,
    run: async () => '結果です',
    stop: (c) => (c.name === 'done' ? '終えた' : undefined),
  })
  expect(summary).toBe('終えた')
  // 最初の messages、応答、ツール結果、応答の順に、同じメッセージを重ねずに残る
  expect(ctx('solve').messages()).toEqual(messages)
  expect(messages.length).toBe(4)
})
