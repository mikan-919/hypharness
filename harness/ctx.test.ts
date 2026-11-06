import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createStore } from '../server/store.ts'
import { recall, runAgent } from './agent.ts'
import { ctx, editContext } from './ctx.ts'
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

const contextPath = (agent: string) => join(process.env.HYPH_CTX_DIR!, `${agent}.md`)
const contextText = (agent: string) => readFileSync(contextPath(agent), 'utf8')

test('文脈ファイルのパスは <root>/<エージェントの id>.md になり、最初の課題文は入らない', () => {
  const store = ctx('solve')
  store.append(message('はじめての指示'))
  store.append(message('2件目'))
  store.append(message('3件目'))
  const path = store.buildContextFile(8)
  expect(path).toBe(join(dir, 'solve.md'))
  const text = contextText('solve')
  expect(text).toContain('3件目')
  expect(text).toContain('2件目')
  expect(text).not.toContain('はじめての指示')
})

test('文脈ファイルには直近の生メッセージと要約ノードが id と種別付きで並ぶ', () => {
  const store = ctx('solve')
  for (let i = 1; i <= 10; i++) store.append(message(`${i}件目`))
  const id = store.addSummary('アルファの要約', [1])
  store.buildContextFile(8)
  const text = contextText('solve')
  expect(text).toContain(`## 要約 ${id}`)
  expect(text).toContain('アルファの要約')
  // 先頭の1件を除いた直近8件だけを入れる
  expect(text).toContain('## 生 3')
  expect(text).toContain('## 生 10')
  expect(text).not.toContain('## 生 2')
})

test('edit_context は old が0回のとき、文脈ファイルも要約ノードも変えず理由を返す', () => {
  const store = ctx('solve')
  store.append(message('はじめての指示'))
  store.append(message('本文あり'))
  store.buildContextFile()
  const before = contextText('solve')
  const reason = editContext('solve', '見つからない語', '置き換え後')
  expect(contextText('solve')).toBe(before)
  expect(ctx('solve').summaries().length).toBe(0)
  expect(reason).toContain('1回も現れない')
})

test('edit_context は old が2回以上現れるとき、文脈ファイルも要約ノードも変えず理由を返す', () => {
  const store = ctx('solve')
  store.append(message('はじめての指示'))
  store.append(message('重なる語 と 重なる語'))
  store.buildContextFile()
  const before = contextText('solve')
  const reason = editContext('solve', '重なる語', '置き換え後')
  expect(contextText('solve')).toBe(before)
  expect(ctx('solve').summaries().length).toBe(0)
  expect(reason).toContain('2回以上')
})

test('edit_context は new が空文字のとき断る', () => {
  const store = ctx('solve')
  store.append(message('はじめての指示'))
  store.append(message('本文あり'))
  store.buildContextFile()
  const before = contextText('solve')
  const reason = editContext('solve', '本文あり', '')
  expect(contextText('solve')).toBe(before)
  expect(ctx('solve').summaries().length).toBe(0)
  expect(reason).toContain('空文字')
})

test('edit_context は old が1回だけ現れるとき、その1箇所を置き換え、要約ノードを1件増やす', () => {
  const store = ctx('solve')
  store.append(message('はじめての指示'))
  store.append(message('置き換える前の文 と そのままの文'))
  store.append(message('置き換える前の文ではない'))
  store.buildContextFile()
  const before = store.messages()
  const reason = editContext('solve', '置き換える前の文 と', '置き換えた後の文 と')
  const text = contextText('solve')
  expect(text).toContain('置き換えた後の文 と そのままの文')
  expect(text).not.toContain('置き換える前の文 と')
  expect(text).toContain('置き換える前の文ではない')
  expect(ctx('solve').summaries().length).toBe(1)
  expect(ctx('solve').summaries()[0].text).toBe(text)
  expect(reason).toContain('要約ノード 1')
  // 元のメッセージは消えない
  expect(ctx('solve').messages()).toEqual(before)
  expect(ctx('solve').messages().length).toBe(3)
})

test('runAgent は毎ターン文脈ファイルを組み立て、パスをシステムプロンプトの末尾に書く。edit_context の結果を返す', async () => {
  const store = createStore()
  const replies = [reply('edit_context', { old: '置き換える前の文', new: '置き換えた後の文' }, 'e1'), reply('done', {}, 'c2')]
  const systems: string[] = []
  const call: Call = async (body) => {
    systems.push(body.context.systemPrompt)
    return replies.shift()!
  }
  const messages: Message[] = [message('はじめての指示'), message('置き換える前の文を含む本文')]
  const results: string[] = []
  const summary = await runAgent<string>({
    store,
    call,
    agent: 'solve',
    taskId: 't1',
    system: 'システムプロンプト',
    tools: [],
    messages,
    run: async () => '結果です',
    stop: (c) => {
      if (c.name !== 'done') return undefined
      results.push(...messages.filter((m) => m.role === 'toolResult').map((m) => (m as any).content[0].text))
      return '終えた'
    },
  })
  expect(summary).toBe('終えた')
  expect(systems[0]).toBe(`システムプロンプト\n文脈ファイル: ${contextPath('solve')}`)
  expect(results[0]).toContain('要約ノード 1')
  const text = contextText('solve')
  expect(text).toContain('置き換えた後の文を含む本文')
  expect(ctx('solve').summaries().map((s) => s.text).join('')).toContain('置き換えた後の文を含む本文')
})
