import type { Store } from './store.ts'
import { type Call, runTopic } from './topic.ts'

// ponytail: 論点エージェントは1つだけ。DeLM で複数の論点を並べるのは、1つで対話が回ってから
// 保存した対話があれば、その続きから始める
export async function startDialog(store: Store, call: Call, repo: string) {
  if (!store.hasTopic('goal')) store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  if (store.snapshot().topics.find((t) => t.id === 'goal')?.ready) return
  const goal = await store.ask({
    topicId: 'goal',
    text: '何を作りたいですか。',
    options: [],
    recommendation: `対象のリポジトリは ${repo} です。思いついている範囲で書いてください。`,
    key: 'seed',
  })
  await runTopic(store, call, 'goal', repo, goal)
}
