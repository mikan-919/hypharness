import type { Store } from './store.ts'
import { type Call, runTopic } from './topic.ts'

// ponytail: 論点エージェントは1つだけ。DeLM で複数の論点を並べるのは、1つで対話が回ってから
export async function startDialog(store: Store, call: Call, repo: string) {
  store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  const goal = await store.ask({
    topicId: 'goal',
    text: '何を作りたいですか。',
    options: [],
    recommendation: `対象のリポジトリは ${repo} です。思いついている範囲で書いてください。`,
  })
  await runTopic(store, call, 'goal', repo, goal)
}
