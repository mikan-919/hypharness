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
      // 実行を始める時点の版。この版より後に利用者の書き換えがあれば、実行が終わった後にもう一度動かす
      const started = store.snapshot().goal.version
      await run({ role: 'topic', topicId: 'goal', repo }).catch((e: Error) => {
        store.record({ topicId: 'goal', kind: 'fail', text: e.message, evidence: '固定部' })
        store.setTopic('goal', { state: 'blocked' })
      })
      // 実行の間の利用者の書き換えでは、モデルの呼び出しを打ち切らずに、実行が終わってから1回だけ動かし直す。
      // 何度保存されても再始動は1回で、届いていない差分は論点エージェントが seen の版から受け取る
      const { edits } = store.snapshot()
      if (edits.some((e) => e.version > started && e.author === 'user')) {
        restart(store)
        continue
      }
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

// 実行の間に利用者が書き換えたときの再始動。開始可を取り消し、答えを待っていた質問を外してから動かし直す
function restart(store: Store) {
  reopen(store)
  store.dropOrphans(new Set())
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
