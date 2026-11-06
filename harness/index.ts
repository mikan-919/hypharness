import type { Store } from './store.ts'
import { type Call, runTopic } from './topic.ts'

// ponytail: 論点エージェントは1つだけ。DeLM で複数の論点を並べるのは、1つで対話が回ってから。
// 開始可になった論点は、利用者がその後に本文を書き換えても起き直さない。必要になったら書き換えで起こす
// 本文が空のうちは、利用者が最初に書くまで待つ。保存した対話があれば、その続きから始める
export async function startDialog(store: Store, call: Call, repo: string) {
  if (!store.hasTopic('goal')) store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  // 前の起動で出したまま、もう答えを待っていない質問を外す。続きから進めると、結果のない ask だけが出し直される
  const transcript = store.transcript('goal') ?? []
  const answered = new Set(transcript.flatMap((m) => (m.role === 'toolResult' ? [m.toolCallId] : [])))
  const last = transcript.findLast((m) => m.role === 'assistant')
  const pending = last?.role === 'assistant' ? last.content.flatMap((c) => (c.type === 'toolCall' && !answered.has(c.id) ? [c.id] : [])) : []
  store.dropOrphans(new Set(pending))
  if (store.snapshot().topics.find((t) => t.id === 'goal')?.ready) return
  if (!store.snapshot().goal.text.trim()) {
    await new Promise<void>((resolve) => {
      const unsubscribe = store.subscribe((dialog) => {
        if (dialog.goal.text.trim()) {
          unsubscribe()
          resolve()
        }
      })
    })
  }
  await runTopic(store, call, 'goal', repo)
}
