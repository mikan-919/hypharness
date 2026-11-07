// 自己改良の1周（最終目的の 6）。弱点・提案・検証・採用を実物でつなぐ。別の命令にはしない（ADR 0002）
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import type { Call } from '../../harness/topic.ts'
import type { Dialog, Task } from '../../shared/dialog.ts'
import { MODULE_SUMMARY, type Candidate } from '../../shared/evolve.ts'
import { deepinfra } from '../model.ts'
import type { Stream } from '../relay.ts'
import { createStore } from '../store.ts'
import { applyAndCheck } from './apply.ts'
import { runRound, type Proposal, type ProposeInput, type RoundResult } from './round.ts'
import { evoPaths, listArchive, listCandidates } from './store.ts'

export type EvolveResult = RoundResult & { spent: number }

export type EvolveOptions = {
  repo?: string
  root?: string
  dialog?: Dialog
  propose?: (input: ProposeInput) => Proposal | Promise<Proposal>
  check?: (candidate: Candidate) => 0 | 1 | Promise<0 | 1>
  spent?: () => number
  limitUsd?: number
  // 候補を当てるハーネスのリポジトリ。既定はこのファイルのあるリポジトリ
  harness?: string
  // モデルの呼び出し先。固定部は中継を通したものを渡す。渡さなければ DeepInfra を直接呼ぶ
  stream?: Stream
  // 検査に通った候補を統合ブランチに積む
  adopt?: boolean
  // 採用した候補を、提案に使わなかった課題で測る。渡さないときは測らない
  holdout?: (candidate: Candidate, tasks: Task[]) => 0 | 1
}

const defaultRoot = () => process.env.HYPH_EVO || join(homedir(), '.hyph', 'evo')

// 対象のリポジトリの対話の状態。server/app.ts の createStore と同じ場所
const dialogOf = (repo: string): Dialog =>
  createStore(join(homedir(), '.hyph', 'dialogs', `${repo.replaceAll('/', '_')}.json`)).snapshot()

// 周の番号。候補とアーカイブにある周の最大に1を足す。1件も無ければ1
const nextRound = (root: string) => {
  const rounds = [...listCandidates(root), ...listArchive(root)].map((c) => c.round)
  return rounds.length === 0 ? 1 : Math.max(...rounds) + 1
}

// 提案の材料に入れる候補の形。holdout が未測定のときは入れない
const candidateMaterial = (c: Candidate) => ({
  id: c.id,
  module: c.module,
  changes: c.changes,
  score: c.score,
  cost: c.cost,
  note: c.note,
  ...(c.holdout === undefined ? {} : { holdout: c.holdout }),
})

// モデルに渡す材料。候補の JSON とコードの場所も入れる
export function proposeMaterial(input: ProposeInput, root: string) {
  return {
    module: input.module,
    summary: MODULE_SUMMARY[input.module],
    weaknesses: input.weaknesses,
    start: input.start ? candidateMaterial(input.start) : [],
    archive: input.archive.map(candidateMaterial),
    failed: input.failed,
    maxChanges: input.maxChanges,
    paths: evoPaths(root),
    code: input.code,
  }
}

const SYSTEM = `あなたは hypharness の自己改良の提案役です。指定されたモジュールの変更案を1つ作ります。

- 弱点と、出発点・archive の候補を参考にする。
- 変更は、そのモジュールのコードに加える具体的な変更を文字列の配列で書く。
- 候補の JSON は \`~/.hyph/evo/candidates/<id>.json\` と \`~/.hyph/evo/archive/<id>.json\` にあり、材料の \`paths\` に場所が入っている。
- コードは \`~/.hyph/evo/code/<id>.md\` にあり、材料の \`code\` に本文が入っている。
- 応答は JSON だけにする。形は {"changes": string[], "note": string}。
- 日本語で書く。修飾表現を使わず、事実を書く。`

// システムプロンプト。失敗した変更を繰り返さないことと、変更の数の上限を書く。上限は入力の maxChanges
const systemPrompt = (maxChanges: number) => `${SYSTEM}
- 失敗した変更（failed）を繰り返さない。
- 変更は指定の個数までにする。個数は ${maxChanges} 個。`

async function askModel(stream: ReturnType<typeof deepinfra>, user: string, system: string) {
  const messages: Message[] = [{ role: 'user', content: user, timestamp: Date.now() }]
  let answer: AssistantMessage | undefined
  for await (const event of stream({ systemPrompt: system, messages, tools: [] })) {
    if (event.type === 'done') answer = event.message
    if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'モデルの呼び出しに失敗しました')
  }
  if (!answer) throw new Error('モデルの応答がありませんでした')
  const text = answer.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
  return { text, costUsd: answer.usage.cost.total }
}

// 応答の本文を { changes, note } に読む。JSON として読めなければ changes を空にし、理由を note に書く
export function readProposal(text: string): Proposal {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch (e) {
    return { changes: [], note: `JSON として読めませんでした: ${(e as Error).message}` }
  }
  const changes = Array.isArray(parsed?.changes) ? parsed.changes.filter((x: unknown) => typeof x === 'string') : []
  const note = typeof parsed?.note === 'string' ? parsed.note : ''
  if (!Array.isArray(parsed?.changes)) {
    return { changes: [], note: note || 'changes が文字列の配列ではありません' }
  }
  return { changes, note }
}

export async function runEvolve(options: EvolveOptions = {}): Promise<EvolveResult> {
  const repo = options.repo ?? process.env.TARGET_REPO ?? process.cwd()
  const root = options.root ?? defaultRoot()
  const dialog = options.dialog ?? dialogOf(repo)
  const limit = options.limitUsd ?? Number(process.env.EVOLVE_LIMIT_USD ?? 1)
  const limitUsd = Number.isFinite(limit) ? limit : 1

  let cost = 0
  const stream = options.stream ?? (options.propose && options.check ? undefined : deepinfra())

  const propose =
    options.propose ??
    (async (input: ProposeInput): Promise<Proposal> => {
      const material = proposeMaterial(input, root)
      try {
        if (!stream) throw new Error('モデルの呼び出し先を作れませんでした')
        const answer = await askModel(stream, JSON.stringify(material), systemPrompt(input.maxChanges))
        cost += answer.costUsd
        return readProposal(answer.text)
      } catch (e) {
        return { changes: [], note: `モデルの呼び出しに失敗しました: ${(e as Error).message}` }
      }
    })

  // 解答役が呼ぶモデル。費用を cost に足す
  const call: Call = async ({ context }) => {
    if (!stream) throw new Error('モデルの呼び出し先を作れませんでした')
    for await (const event of stream(context)) {
      if (event.type === 'error') throw new Error(event.error.errorMessage ?? 'モデルの呼び出しに失敗しました')
      if (event.type === 'done') {
        cost += event.message.usage.cost.total
        return event.message
      }
    }
    throw new Error('モデルの応答がありませんでした')
  }

  // 候補の変更を解答役にコードへ当てさせ、検査を通るかで 0 か 1 にする
  const check =
    options.check ??
    ((candidate: Candidate) =>
      applyAndCheck(candidate, {
        repo: options.harness ?? join(import.meta.dir, '..', '..'),
        call,
        check: process.env.CHECK_COMMAND || 'bun run typecheck && bun test',
        parent: listArchive(root).find((c) => c.id === candidate.parent),
        adopt: options.adopt,
      }))

  const spent = options.spent ?? (() => cost)

  const result = await runRound({
    round: nextRound(root),
    dialog,
    propose,
    check,
    spent,
    limitUsd,
    root,
    holdout: options.holdout,
  })
  return { ...result, spent: spent() }
}

