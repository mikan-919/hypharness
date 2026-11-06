import { expect, test } from 'bun:test'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Job } from '../shared/contract.ts'
import { startDialog } from './dialog.ts'
import { createStore } from './store.ts'

const readyCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'r1', name: 'ready', arguments: {} }],
} as unknown as AssistantMessage

test('開始可になった後、利用者が本文を書き換えたら、開始可を取り消して論点エージェントを動かし直す', async () => {
  const store = createStore()
  store.editGoal('メモの CLI', 0, 'user', '最初')
  const runs: Message[][] = []
  // 論点エージェントの代わり。1回目は ready を呼んで開始可になり、2回目は受け取った会話を残して開始可になる
  const run = async (_job: Job) => {
    const transcript = store.transcript('goal') ?? [{ role: 'user', content: '始め', timestamp: 0 } as Message]
    runs.push([...transcript])
    store.saveTranscript('goal', [...transcript, readyCall])
    store.setTopic('goal', { ready: true, state: 'ready' })
  }
  void startDialog(store, run, '/tmp')
  await Bun.sleep(10)
  expect(runs.length).toBe(1)
  expect(store.snapshot().topics[0].ready).toBe(true)

  // 論点エージェント自身の書き換えでは起き直らない
  store.editGoal('メモの CLI\n保存先: ファイル', 1, 'goal', '保存先を決めた')
  await Bun.sleep(10)
  expect(runs.length).toBe(1)

  store.editGoal('メモの CLI\n保存先: SQLite', 2, 'user', '画面で書き換えた')
  await Bun.sleep(10)
  expect(runs.length).toBe(2)
  // 結果のなかった ready に結果が返され、続きから動く
  const last = runs[1].at(-1)
  expect(last).toMatchObject({ role: 'toolResult', toolCallId: 'r1' })
  expect(JSON.stringify(last)).toContain('開始可を取り消した')
})
