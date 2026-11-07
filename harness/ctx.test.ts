import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import { runAgent } from './agent.ts'
import { workingContext } from './ctx.ts'
import { AGENT_DIET } from './settings.ts'
import type { Call } from './topic.ts'

process.env.HYPH_CTX_DIR = mkdtempSync(join(tmpdir(), 'hyph-ctx-'))

const fakeStore = { act: () => {} } as unknown as AgentStore

const reply = (calls: { name: string; arguments?: object }[], promptTokens = 0): AssistantMessage =>
  ({
    role: 'assistant',
    content: calls.map((c, i) => ({ type: 'toolCall', id: `${c.name}-${Math.random()}-${i}`, name: c.name, arguments: c.arguments ?? {} })),
    usage: { input: promptTokens, output: 0, cacheRead: 0, cacheWrite: 0 },
  }) as unknown as AssistantMessage

// replies の順に応答するモデルで runAgent を動かし、モデルに渡った会話を返す
async function drive(replies: AssistantMessage[], outputs: Record<string, string> = {}) {
  const seen: Message[][] = []
  const messages: Message[] = [{ role: 'user', content: '課題 t1', timestamp: 0 }]
  const call: Call = async ({ context }) => {
    seen.push(context.messages)
    return replies.shift() ?? reply([{ name: 'stop' }])
  }
  await runAgent({
    store: fakeStore,
    call,
    agent: 'solve',
    taskId: 't1',
    system: 'システム',
    tools: [],
    messages,
    contextKey: `test:${Math.random()}`,
    run: async (c) => outputs[c.name] ?? `${c.name} の結果`,
    stop: (c) => (c.name === 'stop' ? 'done' : undefined),
  })
  return { seen, messages }
}

const texts = (value: unknown) => JSON.stringify(value)

test('縮めない間は、前の呼び出しの会話を先頭にそのまま足していく（キャッシュが効く）', async () => {
  const { seen } = await drive([reply([{ name: 'read_file' }]), reply([{ name: 'read_file' }])])
  expect(seen[1].slice(0, seen[0].length)).toEqual(seen[0])
  expect(seen[2].slice(0, seen[1].length)).toEqual(seen[1])
})

test('edit_context を呼ぶと、次の呼び出しからそれまでの会話の代わりに作業文脈を渡す', async () => {
  const { seen, messages } = await drive(
    [reply([{ name: 'read_file' }]), reply([{ name: 'edit_context', arguments: { content: '要点: 関数 f を直す' } }]), reply([{ name: 'list_files' }])],
    { read_file: '長いファイルの中身' },
  )
  expect(texts(seen[2])).not.toContain('長いファイルの中身')
  expect(seen[2][0]).toMatchObject({ role: 'user', content: '課題 t1' })
  expect(texts(seen[2][1])).toContain('要点: 関数 f を直す')
  expect(seen[2]).toHaveLength(2)
  // 原文は消さない
  expect(texts(messages)).toContain('長いファイルの中身')
  // 置き換えた後は、また先頭を変えずに足していく
  expect(seen[3].slice(0, seen[2].length)).toEqual(seen[2])
})

test('recall は、作業文脈に置き換えた会話の原文を返す', async () => {
  const { messages } = await drive(
    [
      reply([{ name: 'read_file' }]),
      reply([{ name: 'edit_context', arguments: { content: '要点だけ' } }]),
      reply([{ name: 'recall', arguments: { query: 'ひみつの値' } }]),
    ],
    { read_file: 'ひみつの値は 42' },
  )
  const recalled = messages.find((m) => m.role === 'toolResult' && m.toolName === 'recall')
  expect(texts([recalled!])).toContain('ひみつの値は 42')
})

test('edit_context は content が空なら置き換えない', async () => {
  const { seen } = await drive([reply([{ name: 'read_file' }]), reply([{ name: 'edit_context', arguments: { content: ' ' } }])])
  expect(texts(seen[2])).toContain('read_file の結果')
})

test('文脈がしきい値を超えたら、直近の件数を残して古い会話を要約に置き換える', async () => {
  const over = AGENT_DIET.compactAtTokens + 1
  const replies = Array.from({ length: 10 }, (_, i) => reply([{ name: 'read_file' }], i === 9 ? over : 10))
  const { seen } = await drive(replies, { read_file: '中身' })
  const before = seen[9]
  const after = seen[10]
  expect(after.length).toBeLessThan(before.length)
  expect(after[0]).toMatchObject({ content: '課題 t1' })
  expect(texts(after[1])).toContain('作業文脈')
  // 呼び出しのないツールの結果から始めない
  expect(after[2].role).not.toBe('toolResult')
})

test('しきい値の半分を超えたら、最後のツールの結果に文脈の大きさを書き添える', async () => {
  const { messages } = await drive([reply([{ name: 'read_file' }], AGENT_DIET.compactAtTokens / 2 + 1)])
  const result = messages.findLast((m) => m.role === 'toolResult')
  expect(texts([result!])).toContain('edit_context で自分で縮められる')
})

test('作業文脈は key ごとに分かれ、同じ key なら開き直しても残る', () => {
  const messages: Message[] = [
    { role: 'user', content: '課題', timestamp: 0 },
    { role: 'user', content: '古い', timestamp: 0 },
  ]
  workingContext('a').replace(messages, '要点')
  expect(texts(workingContext('a').view(messages))).toContain('要点')
  expect(workingContext('b').view(messages)).toEqual(messages)
})

test('会話より先を指す作業文脈は、前の試行からやり直した別の会話のものとして使わない', () => {
  const context = workingContext(`stale-${Math.random()}`)
  const long: Message[] = Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `m${i}`, timestamp: 0 }))
  context.replace(long, '途中で止まった試行の要約')
  const short = long.slice(0, 3)
  expect(context.view(short)).toEqual(short)
  expect(context.view(long)[1]).toMatchObject({ content: expect.stringContaining('途中で止まった試行の要約') })
})
