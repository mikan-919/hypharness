// 改良の対象の入口（ADR 0022）。固定部が版ごとに子プロセスとして起動し、仕事を1つだけ行う。
// 環境変数 HYPH_JOB に仕事、HYPH_RELAY に中継のソケット、HYPH_HOST に対話の状態の受け口のソケットを受け取る。
// 最後の行に結果（HYPH_RESULT）か、エージェントとしての誤り（HYPH_ERROR）を書く
import { CostLimitError, ERROR, type Job, RESULT, type WorkerError } from '../shared/contract.ts'
import { remoteStore } from './remote.ts'
import { decompose, solve } from './roles.ts'
import { relayCall, relayCharge, runTopic } from './topic.ts'

const job = JSON.parse(process.env.HYPH_JOB ?? '{}') as Job
const relay = process.env.HYPH_RELAY ?? ''
const store = remoteStore(process.env.HYPH_HOST ?? '')
const call = relayCall(relay, (agent, text) => store.setLive(agent, text))

try {
  const result =
    job.role === 'topic'
      ? await runTopic(store, call, job.topicId, job.repo, relayCharge(relay))
      : job.role === 'decompose'
        ? await decompose(store, call, job)
        : job.role === 'solve'
          ? await solve(store, call, job)
          : undefined
  await store.flush()
  console.log(`\n${RESULT}${JSON.stringify(result ?? null)}`)
} catch (e) {
  await store.flush()
  const error: WorkerError = { message: (e as Error).message, cost: e instanceof CostLimitError }
  console.log(`\n${ERROR}${JSON.stringify(error)}`)
}
