import { expect, test } from 'bun:test'
import { buildGraph, type Call, type Message } from './graph'

const user = (content: string): Message => ({ role: 'user', content })
const call = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): Message => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
})
const result = (id: string, name: string, text: string): Message => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
})

test('会話ごとに列を分け、委任の行きと戻りを結び、圧縮で短くなった結果は長い方を残す', () => {
  const parent = { systemPrompt: '親' }
  const child = { systemPrompt: '子' }
  const calls: Call[] = [
    {
      context: { ...parent, messages: [user('課題')] },
      reply: call('a', 'sh', { cmd: 'ls' }),
    },
    {
      context: {
        ...parent,
        messages: [
          user('課題'),
          call('a', 'sh', { cmd: 'ls' }),
          result('a', 'sh', '長い出力'),
        ],
      },
      reply: call('b', 'delegate', { goal: '調べる' }),
    },
    {
      context: { ...child, messages: [user('調べる')] },
      reply: { role: 'assistant', content: [{ type: 'text', text: '要約' }] },
    },
    {
      context: {
        ...parent,
        messages: [
          user('課題'),
          call('a', 'sh', { cmd: 'ls' }),
          result('a', 'sh', '短'),
          call('b', 'delegate', { goal: '調べる' }),
          result('b', 'delegate', '要約'),
        ],
      },
      reply: call('c', 'finish', {}),
    },
  ]
  const g = buildGraph(calls)
  expect(g.lanes).toBe(2)
  expect(g.steps.find((s) => s.kind === 'result' && s.lane === 0)?.text).toBe(
    '長い出力',
  )
  expect(g.steps.find((s) => s.kind === 'tool' && s.lane === 0)?.text).toBe(
    'ls',
  )
  const delegate = g.steps.find((s) => s.title === 'delegate')
  const childGoal = g.steps.find((s) => s.lane === 1 && s.kind === 'goal')
  const go = g.edges.find((e) => e.kind === 'delegate')
  expect(go?.from).toBe(delegate?.id as string)
  expect(go?.to).toBe(childGoal?.id as string)
  const back = g.edges.find((e) => e.kind === 'return')
  expect(g.steps.find((s) => s.id === back?.to)?.title).toBe('delegate の結果')
})
