import { expect, test } from 'bun:test'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Job } from '../shared/contract.ts'
import { startDialog } from './dialog.ts'
import { createStore } from './store.ts'

const readyCall = {
  role: 'assistant',
  content: [{ type: 'toolCall', id: 'r1', name: 'ready', arguments: {} }],
} as unknown as AssistantMessage

// 論点エージェントの代わり。受け取った会話を残し、ready を呼んで開始可になる
function fakeRun(store: ReturnType<typeof createStore>, runs: Message[][], during?: (n: number) => void) {
  return async (_job: Job) => {
    const transcript = store.transcript('goal') ?? [{ role: 'user', content: '始め', timestamp: 0 } as Message]
    runs.push([...transcript])
    during?.(runs.length)
    store.saveTranscript('goal', [...transcript, readyCall])
    store.setTopic('goal', { ready: true, state: 'ready' })
  }
}

test('開始可になった後、利用者が本文を書き換えたら、開始可を取り消して論点エージェントを動かし直す', async () => {
  const store = createStore()
  store.editGoal('メモの CLI', 0, 'user', '最初')
  const runs: Message[][] = []
  void startDialog(store, fakeRun(store, runs), '/tmp')
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

test('実行の間に利用者が保存したら、その実行が終わった後にもう一度論点エージェントを動かす', async () => {
  const store = createStore()
  store.editGoal('メモの CLI', 0, 'user', '最初')
  const runs: Message[][] = []
  // 1回目の実行の間に2回保存する
  void startDialog(
    store,
    fakeRun(store, runs, (n) => {
      if (n > 1) return
      store.editGoal('メモの CLI\n保存先: ファイル', store.snapshot().goal.version, 'user', '実行中の1回目')
      store.editGoal('メモの CLI\n保存先: SQLite', store.snapshot().goal.version, 'user', '実行中の2回目')
    }),
    '/tmp',
  )
  await Bun.sleep(20)
  // 2回保存しても、起動は1回増えるだけ
  expect(runs.length).toBe(2)
  expect(store.snapshot().topics[0].ready).toBe(true)
  expect(store.snapshot().topics[0].state).toBe('ready')
  // 結果のなかった ready に結果が返され、続きから動く
  expect(runs[1].at(-1)).toMatchObject({ role: 'toolResult', toolCallId: 'r1' })
})

test('実行の間の論点エージェント自身の書き換えでは再始動しない', async () => {
  const store = createStore()
  store.editGoal('メモの CLI', 0, 'user', '最初')
  const runs: Message[][] = []
  void startDialog(
    store,
    fakeRun(store, runs, (n) => {
      if (n > 1) return
      store.editGoal('メモの CLI\n保存先: ファイル', store.snapshot().goal.version, 'goal', '論点が決めた')
    }),
    '/tmp',
  )
  await Bun.sleep(20)
  expect(runs.length).toBe(1)
  expect(store.snapshot().topics[0].ready).toBe(true)
})

test('再始動の前に開始可を取り消し、答え待ちの質問を questions と queue から外す', async () => {
  const store = createStore()
  store.editGoal('メモの CLI', 0, 'user', '最初')
  const runs: Message[][] = []
  const seen: { questions: number; queue: number }[] = []
  void startDialog(
    store,
    fakeRun(store, runs, (n) => {
      if (n > 1) return
      // 答え待ちの質問を1つ出す
      void store.ask({ topicId: 'goal', text: '保存先は?', options: [], recommendation: '', key: 'a1' })
      store.editGoal('メモの CLI\n保存先: SQLite', store.snapshot().goal.version, 'user', '実行中の書き換え')
      // 再始動より前の、実行の途中の時点で質問が出ている
      seen.push({ questions: store.snapshot().questions.length, queue: store.snapshot().queue.length })
    }),
    '/tmp',
  )
  await Bun.sleep(20)
  expect(runs.length).toBe(2)
  expect(seen).toEqual([{ questions: 1, queue: 1 }])
  const { questions, queue } = store.snapshot()
  expect(questions).toEqual([])
  expect(queue).toEqual([])
  // 外した質問への答えは受け付けない（/api/answer は 409 を返す）
  expect(store.answer('q1', 'SQLite')).toEqual({ ok: false, waiting: false })
  expect(store.snapshot().questions).toEqual([])
})
