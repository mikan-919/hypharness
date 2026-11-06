import { expect, test } from 'bun:test'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { createStore } from './store.ts'
import { type Call, runTopic } from './topic.ts'

const reply = (name: string, args: object) =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id: name, name, arguments: args }] }) as unknown as AssistantMessage

// 決めた順にツールを呼ぶモデルの代わり。受け取った会話を残す
function script(...replies: AssistantMessage[]) {
  const seen: Message[][] = []
  const call: Call = async ({ context }) => {
    seen.push([...context.messages])
    return replies.shift() ?? reply('ready', {})
  }
  return { call, seen }
}

test('質問を待ち行列に入れ、答えを受け取って続け、ready で終える', async () => {
  const store = createStore()
  store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  const { call, seen } = script(
    reply('ask', { text: 'どこに残しますか', options: [], recommendation: '理由' }),
    reply('record', { kind: 'done', text: 'ファイルに残す', evidence: '利用者の答え' }),
  )
  const done = runTopic(store, call, 'goal', import.meta.dir, '対話を見返したい')
  await Bun.sleep(0)
  expect(store.snapshot().queue).toEqual(['q1'])
  expect(store.snapshot().topics[0].state).toBe('asking')
  expect(store.answer('q1', 'ファイル')).toBe(true)
  await done
  expect(store.snapshot().topics[0]).toMatchObject({ state: 'ready', ready: true })
  expect(store.snapshot().entries.map((e) => e.text)).toEqual(['ファイルに残す'])
  expect(JSON.stringify(seen[1])).toContain('利用者の答え: ファイル')
})

test('リポジトリの外は読ませない', async () => {
  const store = createStore()
  store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  const { call, seen } = script(reply('read_file', { path: '../../../etc/passwd' }))
  await runTopic(store, call, 'goal', import.meta.dir, '出発点')
  expect(JSON.stringify(seen[1])).toContain('リポジトリの外です')
})
