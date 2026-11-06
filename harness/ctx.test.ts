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

test('追記が8件以下のときは要約ノードが増えない', () => {
  const store = ctx('solve')
  for (let i = 1; i <= 8; i++) store.append(message(`${i}件目`))
  expect(store.summarizeOld(8)).toBeUndefined()
  expect(store.summaries()).toEqual([])
})

test('9件以上で呼ぶと要約ノードが1件増え、messageIds は直近8件より前の id になる', () => {
  const store = ctx('solve')
  for (let i = 1; i <= 10; i++) store.append(message(`${i}件目`))
  const id = store.summarizeOld(8)
  expect(store.summaries().length).toBe(1)
  expect(store.summary(id!)).toEqual({ id: id!, text: '1件目\n2件目', messageIds: [1, 2] })
})

test('同じ状態で2回呼んでも、要約ノードは増えない', () => {
  const store = ctx('solve')
  for (let i = 1; i <= 10; i++) store.append(message(`${i}件目`))
  store.summarizeOld(8)
  expect(store.summarizeOld(8)).toBeUndefined()
  expect(store.summaries().length).toBe(1)
})

test('要約ノードを足した後も、messages() の件数と本文は変わらない', () => {
  const store = ctx('solve')
  for (let i = 1; i <= 10; i++) store.append(message(`${i}件目`))
  const before = store.messages()
  store.summarizeOld(8)
  expect(store.messages()).toEqual(before)
  expect(store.messages().length).toBe(10)
})

test('要約ノードの本文は、1件あたり500文字で切った本文を順につないだものになる', () => {
  const store = ctx('solve')
  store.append(message('a'.repeat(600)))
  store.append(message('b'.repeat(600)))
  for (let i = 1; i <= 8; i++) store.append(message(`${i}件目`))
  const id = store.summarizeOld(8)!
  expect(store.summary(id)!.text).toBe(`${'a'.repeat(500)}\n${'b'.repeat(500)}`)
})

test('runAgent は4ターン目に要約ノードを1件作り、5ターン目には増やさない', async () => {
  const store = createStore()
  const replies = [
    reply('read_file', { path: 'a' }, 'c1'),
    reply('read_file', { path: 'a' }, 'c2'),
    reply('read_file', { path: 'a' }, 'c3'),
    reply('read_file', { path: 'a' }, 'c4'),
    reply('read_file', { path: 'a' }, 'c5'),
    reply('done', {}, 'c6'),
  ]
  const call: Call = async () => replies.shift()!
  const messages: Message[] = [message('はじめての指示')]
  // 各ターンのツールを動かす時点での要約ノードの件数
  const counts: number[] = []
  const summary = await runAgent<string>({
    store,
    call,
    agent: 'solve',
    taskId: 't1',
    system: '',
    tools: [],
    messages,
    run: async () => {
      counts.push(ctx('solve').summaries().length)
      return '結果です'
    },
    stop: (c) => (c.name === 'done' ? '終えた' : undefined),
  })
  expect(summary).toBe('終えた')
  expect(counts).toEqual([0, 0, 0, 0, 1])
  expect(ctx('solve').summaries().length).toBe(1)
})
