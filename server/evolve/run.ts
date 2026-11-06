// 自己改良を1周だけ回す入口（最終目的の 6 の 10）。弱点・提案・検証・採用を実物でつなぐ
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { sandboxed } from '../../harness/sandbox.ts'
import type { Dialog } from '../../shared/dialog.ts'
import { MODULE_SUMMARY, type Candidate } from '../../shared/evolve.ts'
import { deepinfra } from '../model.ts'
import { createStore } from '../store.ts'
import { runRound, type Proposal, type ProposeInput, type RoundResult } from './round.ts'
import { listArchive, listCandidates } from './store.ts'

export type EvolveResult = RoundResult & { spent: number }

export type EvolveOptions = {
  repo?: string
  root?: string
  dialog?: Dialog
  propose?: (input: ProposeInput) => Proposal | Promise<Proposal>
  check?: (candidate: Candidate) => 0 | 1 | Promise<0 | 1>
  spent?: () => number
  limitUsd?: number
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

const SYSTEM = `あなたは hypharness の自己改良の提案役です。指定されたモジュールの変更案を1つ作ります。

- 弱点と、出発点・archive の候補を参考にする。
- 変更は、そのモジュールのコードに加える具体的な変更を文字列の配列で書く。
- 応答は JSON だけにする。形は {"changes": string[], "note": string}。
- 日本語で書く。修飾表現を使わず、事実を書く。`

async function askModel(stream: ReturnType<typeof deepinfra>, user: string) {
  const messages: Message[] = [{ role: 'user', content: user, timestamp: Date.now() }]
  let answer: AssistantMessage | undefined
  for await (const event of stream({ systemPrompt: SYSTEM, messages, tools: [] })) {
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
  const stream = options.propose ? undefined : deepinfra()

  const propose =
    options.propose ??
    (async (input: ProposeInput): Promise<Proposal> => {
      const material = {
        module: input.module,
        summary: MODULE_SUMMARY[input.module],
        weaknesses: input.weaknesses,
        start: input.start?.changes ?? [],
        archive: input.archive.map((c) => ({ id: c.id, module: c.module, changes: c.changes })),
      }
      try {
        if (!stream) throw new Error('モデルの呼び出し先を作れませんでした')
        const answer = await askModel(stream, JSON.stringify(material))
        cost += answer.costUsd
        return readProposal(answer.text)
      } catch (e) {
        return { changes: [], note: `モデルの呼び出しに失敗しました: ${(e as Error).message}` }
      }
    })

  const check =
    options.check ??
    (async (): Promise<0 | 1> => {
      try {
        const typecheck = await sandboxed(repo, 'bun run typecheck')
        const test = await sandboxed(repo, 'bun test')
        return typecheck.code === 0 && test.code === 0 ? 1 : 0
      } catch {
        return 0
      }
    })

  const spent = options.spent ?? (() => cost)

  const result = await runRound({
    round: nextRound(root),
    dialog,
    propose,
    check,
    spent,
    limitUsd,
    root,
  })
  return { ...result, spent: spent() }
}

if (import.meta.main) {
  try {
    process.loadEnvFile('.env')
  } catch {}
  if (!process.env.DEEPINFRA_API_KEY) {
    console.log('DEEPINFRA_API_KEY が無いため、モデルを呼べません。')
  } else {
    try {
      const result = await runEvolve()
      console.log(`周: ${result.round}`)
      console.log(`出発点: ${result.start?.id ?? 'なし'}`)
      for (const c of result.candidates) console.log(`候補: ${c.id} ${c.module} score ${c.score}`)
      console.log(`stopped: ${result.stopped}`)
      console.log(`費用: ${result.spent}`)
    } catch (e) {
      console.log(`改良の1周に失敗しました: ${(e as Error).message}`)
    }
  }
}
