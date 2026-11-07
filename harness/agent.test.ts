import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import { runAgent } from './agent.ts'
import { AGENT_DIET } from './settings.ts'
import type { Call } from './topic.ts'

// 会話の置き場はテストの一時ディレクトリにする
process.env.HYPH_CTX_DIR = mkdtempSync(join(tmpdir(), 'hyph-agent-'))

// runAgent が使うのは act だけなので、それだけを持つ store を渡す
const fakeStore = (acted: string[]) => ({ act: (_a: string, _k: string, text: string) => void acted.push(text) }) as unknown as AgentStore

const toolCall = (name: string): AssistantMessage =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id: name, name, arguments: {} }] }) as unknown as AssistantMessage

// ツールを1回呼ばせ、その結果を文脈に入れてから stop で終える
async function through(text: string) {
  const messages: Message[] = [{ role: 'user', content: '課題 t1:\n進める', timestamp: Date.now() }]
  let turn = 0
  const call: Call = async () => {
    turn++
    return turn === 1 ? toolCall('tool') : toolCall('stop')
  }
  const acted: string[] = []
  await runAgent<string>({
    store: fakeStore(acted),
    call,
    agent: 'testing',
    taskId: 't1',
    system: 'システムプロンプト',
    tools: [],
    messages,
    run: async () => text,
    stop: (c) => (c.name === 'stop' ? '終わり' : undefined),
  })
  const result = messages.find((m) => m.role === 'toolResult') as any
  return { messages, result, body: result.content[0].text as string }
}

test('連続する同じ行は1行にしてツール結果に入れる', async () => {
  const { body } = await through('同じ\n同じ\n同じ\n次')
  expect(body).toBe('同じ\n次')
})

test('連続する空行は1つの空行にしてツール結果に入れる', async () => {
  const { body } = await through('前\n\n\n\n後')
  expect(body).toBe('前\n\n後')
})

test('10,000 文字を超えるツール結果は後ろから切る', async () => {
  const { body } = await through('x'.repeat(12_000))
  expect(body.length).toBe(10_000)
})

test('文脈の先頭はそのままで、足すのは末尾にする', async () => {
  const { messages, result } = await through('結果')
  expect(messages[0]).toMatchObject({ role: 'user', content: '課題 t1:\n進める' })
  expect(messages.indexOf(result)).toBeGreaterThan(0)
})

test('文脈が上限の 70% を超えると、edit_context の結果に要約して縮める指示が入る', async () => {
  const { ctx } = await import('./ctx.ts')
  const store = ctx('far')
  store.append({ role: 'user', content: 'はじめての指示', timestamp: Date.now() })
  store.append({ role: 'user', content: '置き換える前の文', timestamp: Date.now() })
  store.addSummary('x'.repeat(4 * 734_000), [])
  store.buildContextFile()
  const messages: Message[] = [{ role: 'user', content: '課題 t1:\n進める', timestamp: Date.now() }]
  let turn = 0
  const call: Call = async () =>
    turn++ === 0
      ? ({ role: 'assistant', content: [{ type: 'toolCall', id: 'e', name: 'edit_context', arguments: { old: '置き換える前の文', new: '置き換えた後の文' } }] }) as unknown as AssistantMessage
      : toolCall('stop')
  await runAgent<string>({
    store: fakeStore([]),
    call,
    agent: 'far',
    taskId: 't1',
    system: 'システムプロンプト',
    tools: [],
    messages,
    run: async () => '',
    stop: (c) => (c.name === 'stop' ? '終わり' : undefined),
  })
  const result = messages.find((m) => m.role === 'toolResult') as any
  expect(result.toolName).toBe('edit_context')
  expect(result.content[0].text).toContain('要約して縮めて')
  expect(result.content[0].text).toContain('edit_context')
})

test('AGENT_DIET.toolResultMaxChars を変えると、ツール結果を切る長さがその値になる', async () => {
  const before = AGENT_DIET.toolResultMaxChars
  AGENT_DIET.toolResultMaxChars = 5
  try {
    const { body } = await through('abcdefghij')
    expect(body).toBe('abcde')
  } finally {
    AGENT_DIET.toolResultMaxChars = before
  }
})

test('AGENT_DIET.collapseRepeatedLines を false にすると、連続する同じ行を1行にまとめない', async () => {
  const before = AGENT_DIET.collapseRepeatedLines
  AGENT_DIET.collapseRepeatedLines = false
  try {
    const { body } = await through('同じ\n同じ\n次')
    expect(body).toBe('同じ\n同じ\n次')
  } finally {
    AGENT_DIET.collapseRepeatedLines = before
  }
})

test('AGENT_DIET.summaryEvery を変えると、要約ノードが増える間隔がその値になる', async () => {
  const before = AGENT_DIET.summaryEvery
  AGENT_DIET.summaryEvery = 1
  try {
    const { ctx } = await import('./ctx.ts')
    const { createStore } = await import('../server/store.ts')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    process.env.HYPH_CTX_DIR = mkdtempSync(join(tmpdir(), 'hyph-agent-every-'))
    const replies = Array.from({ length: 6 }, (_, i) => toolCall('tool'))
    let turn = 0
    const call: Call = async () => (turn++ < 6 ? replies[turn - 1] : toolCall('stop'))
    const messages: Message[] = [{ role: 'user', content: '課題 t1:\n進める', timestamp: Date.now() }]
    const counts: number[] = []
    await runAgent<string>({
      store: fakeStore([]),
      call,
      agent: 'every',
      taskId: 't1',
      system: '',
      tools: [],
      messages,
      run: async () => {
        counts.push(ctx('every').summaries().length)
        return '結果です'
      },
      stop: (c) => (c.name === 'stop' ? '終わり' : undefined),
    })
    // 1ターンごとに要約ノードの増え方を確かめる。直近8件より前ができてから増える
    expect(counts).toEqual([0, 0, 0, 0, 1, 2])
    expect(ctx('every').summaries().length).toBe(3)
  } finally {
    AGENT_DIET.summaryEvery = before
  }
})
