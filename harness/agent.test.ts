import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { AgentStore } from '../shared/contract.ts'
import { runAgent } from './agent.ts'
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
