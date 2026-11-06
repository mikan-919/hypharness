// 論点エージェントを動かす順番（固定部、ADR 0022）。論点エージェントそのものは topic として子プロセスで動く
import type { ToolCall } from '@earendil-works/pi-ai'
import type { Job } from '../shared/contract.ts'
import type { Dialog } from '../shared/dialog.ts'
import type { Store } from './store.ts'

// ponytail: 論点エージェントは1つだけ。DeLM で複数の論点を並べるのは、1つで対話が回ってから
// 本文が空のうちは、利用者が最初に書くまで待つ。保存した対話があれば、その続きから始める。
// 論点エージェントが終わったら（開始可になっても、誤りで止まっても）、利用者が本文を書き換えるか質問に答えるまで待ち、動かし直す
export async function startDialog(store: Store, run: (job: Job) => Promise<unknown>, repo: string) {
  if (!store.hasTopic('goal')) store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  // 前の起動で出したまま、もう答えを待っていない質問を外す。続きから進めると、結果のない ask だけが出し直される
  store.dropOrphans(new Set(pendingCalls(store).map((c) => c.id)))
  if (!store.snapshot().goal.text.trim()) await waitFor(store, (d) => Boolean(d.goal.text.trim()))
  while (true) {
    if (!store.snapshot().topics.find((t) => t.id === 'goal')?.ready) {
      await run({ role: 'topic', topicId: 'goal', repo }).catch((e: Error) => {
        store.record({ topicId: 'goal', kind: 'fail', text: e.message, evidence: '固定部' })
        store.setTopic('goal', { state: 'blocked' })
      })
    }
    const { goal, questions } = store.snapshot()
    const answered = questions.filter((q) => q.answer).length
    await waitFor(
      store,
      (d) =>
        d.edits.some((e) => e.version > goal.version && e.author === 'user') || d.questions.filter((q) => q.answer).length > answered,
    )
    reopen(store)
  }
}

// 最後の応答のツールの呼び出しのうち、結果のないもの
function pendingCalls(store: Store) {
  const transcript = store.transcript('goal') ?? []
  const answered = new Set(transcript.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])))
  const last = transcript.findLast((m) => m.role === 'assistant')
  return last?.role === 'assistant'
    ? last.content.filter((c): c is ToolCall => c.type === 'toolCall' && !answered.has(c.id))
    : []
}

// 開始可を取り消して、論点エージェントが続きから動けるようにする。結果のない呼び出し（ready など）に結果を返さないと、
// エージェントは同じ呼び出しをそのまま処理し、すぐにまた開始可になる。答え待ちの ask は、答えを受け取れるよう残す
function reopen(store: Store) {
  const transcript = store.transcript('goal')
  const calls = pendingCalls(store).filter((c) => c.name !== 'ask')
  if (transcript && calls.length > 0) {
    for (const c of calls) {
      transcript.push({
        role: 'toolResult',
        toolCallId: c.id,
        toolName: c.name,
        content: [{ type: 'text', text: '利用者が本文を書き換えたか質問に答えたため、開始可を取り消した。届いた差分と答えを読んで続けてください。' }],
        isError: false,
        timestamp: Date.now(),
      })
    }
    store.saveTranscript('goal', transcript)
  }
  store.setTopic('goal', { ready: false, state: 'researching' })
}

function waitFor(store: Store, ok: (dialog: Dialog) => boolean) {
  return new Promise<void>((resolve) => {
    const unsubscribe = store.subscribe((dialog) => {
      if (!ok(dialog)) return
      unsubscribe()
      resolve()
    })
  })
}
