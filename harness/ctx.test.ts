import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createStore } from '../server/store.ts'
import { recall, runAgent } from './agent.ts'
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

test('メッセージを id 付きで返す', () => {
  const store = ctx('solve')
  store.append(message('1件目'))
  store.append(message('2件目'))
  expect(store.messagesWithIds()).toEqual([
    { id: 1, message: message('1件目') },
    { id: 2, message: message('2件目') },
  ])
})

test('要約ノードを足しても元のメッセージの件数と本文は変わらず、要約を id で引ける', () => {
  const store = ctx('solve')
  store.append(message('長い本文 alphaword を含む'))
  store.append(message('別のメッセージ'))
  const before = store.messages()
  const id = store.addSummary('alphaword の要約', [1])
  expect(store.messages()).toEqual(before)
  expect(store.messages().length).toBe(2)
  expect(store.summary(id)).toEqual({ id, text: 'alphaword の要約', messageIds: [1] })
})

test('recall は一致したメッセージの全文と、そのメッセージを含む要約ノードの id を返す', () => {
  const store = ctx('solve')
  store.append(message('長い本文 alphaword を含む'))
  store.append(message('別のメッセージ'))
  const id = store.addSummary('alphaword の要約', [1])
  const found = store.search('alphaword')
  expect(found.messages).toEqual([{ id: 1, text: '長い本文 alphaword を含む', summaries: [id] }])
  expect(found.summaries).toEqual([{ id, text: 'alphaword の要約' }])
  const text = recall('solve', 'alphaword')
  expect(text).toContain('長い本文 alphaword を含む')
  expect(text).toContain(`メッセージ 1（要約 ${id} に含まれる）`)
})

test('要約ノードの本文だけに一致したときは、その id と本文を返す', () => {
  const store = ctx('solve')
  store.append(message('元のメッセージ'))
  const id = store.addSummary('要約のみ betaword', [1])
  const found = store.search('betaword')
  expect(found.messages).toEqual([])
  expect(found.summaries).toEqual([{ id, text: '要約のみ betaword' }])
})

test('一致が無いときは、その旨の文を返す', () => {
  ctx('solve').append(message('関係のない本文'))
  expect(ctx('solve').search('見つからない語')).toEqual({ messages: [], summaries: [] })
  expect(recall('solve', '見つからない語')).toBe('一致するメッセージや要約はありません。')
})

test('max_results の既定は 5', () => {
  const store = ctx('solve')
  for (let i = 0; i < 7; i++) store.append(message(`同じ語 gammaword ${i}`))
  expect(store.search('gammaword').messages.length).toBe(5)
  expect(store.search('gammaword', 2).messages.length).toBe(2)
  expect(recall('solve', 'gammaword', 3).split('メッセージ ').length - 1).toBe(3)
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
