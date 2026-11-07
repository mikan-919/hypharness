// 自己改良の1周（最終目的の 6 の 1〜9）。弱点を集め、モジュールごとに候補を作り、検証して、通ったものだけを残す。
import type { Dialog, Task } from '../../shared/dialog.ts'
import {
  MODULES,
  paretoPrompts,
  rankPrompts,
  type Candidate,
  type Module,
  type PromptCandidate,
} from '../../shared/evolve.ts'
import { readPrompts, writePrompts } from './prompts.ts'
import { specCandidates, type Failure } from './spec.ts'
import { archiveCandidate, listArchive, listCandidates, readCode, writeCandidate } from './store.ts'

// 提案に渡す材料。archive は前の周までの採用済みの候補、start はこの周の出発点。
// failed は検証に通らなかった変更の履歴、maxChanges は1つの候補に残す変更の数の上限。
// prompts はそのモジュールで残っている Pareto のプロンプトの候補を rankPrompts の順にしたもの。
// code は start と archive の候補のコードの本文で、archive の並び順
export type ProposeInput = {
  module: Module
  weaknesses: string[]
  archive: Candidate[]
  round: number
  start?: Candidate
  failed: string[]
  maxChanges: number
  prompts: PromptCandidate[]
  code: { id: string; text: string }[]
}

// 提案の返り値。id・round・module・score・cost は runRound が入れる。
// prompt はそのモジュールのプロンプトの候補。空でなければ pass で測る
export type Proposal = {
  changes: string[]
  note?: string
  prompt?: string
  // 提案役に実際に渡した材料 JSON と、返した本文
  proposalMaterial?: string
  proposalResponse?: string
}

// プロンプトの候補を課題ごとの通過（0 か 1）で測る。渡さないときはモデルを呼ばずに空の結果にする
export type Pass = (candidate: PromptCandidate) => Record<string, 0 | 1> | Promise<Record<string, 0 | 1>>

// 採用した候補を、提案に使わなかった課題（積んだ課題）で測る。渡さないときは測らない
export type Holdout = (candidate: Candidate, tasks: Task[]) => 0 | 1

export type RoundOptions = {
  round: number
  dialog: Dialog
  propose: (input: ProposeInput) => Proposal | Promise<Proposal>
  check: (candidate: Candidate) => 0 | 1 | Promise<0 | 1>
  spent: () => number
  limitUsd: number
  root?: string
  pass?: Pass
  holdout?: Holdout
  // 失敗したテストの一覧。渡されたときは仕様の候補も作って書く
  failures?: Failure[]
  // 候補が増えるたびに、その時点の候補の一覧を受け取る
  report?: (candidates: Candidate[]) => void
}

export type RoundResult = {
  round: number
  candidates: Candidate[]
  stopped: boolean
  start?: Candidate
  rejected: { module: Module; reason: string }[]
}

// 対話の状態から失敗の型を集める。entries の失敗の項目が先、保留の課題の理由が後。同じ文字列は1つにする
export function weaknesses(dialog: Dialog): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (text: string) => {
    if (seen.has(text)) return
    seen.add(text)
    out.push(text)
  }
  for (const entry of dialog.entries) {
    if (entry.kind === 'fail') add(entry.text)
  }
  for (const task of dialog.tasks) {
    if (task.state === 'held') add(task.reason)
  }
  return out
}

// 1つの候補に残す変更の数の上限。周の番号が 10 以下なら 3、11 以上なら 1
export function changeLimit(round: number): number {
  return round <= 10 ? 3 : 1
}

// 検証に通らなかった候補（score が 0）の変更を順につなぐ。同じ文字列は1つにする
export function failedChanges(history: Candidate[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const candidate of history) {
    if (candidate.score !== 0) continue
    for (const change of candidate.changes) {
      if (seen.has(change)) continue
      seen.add(change)
      out.push(change)
    }
  }
  return out
}

// archive から周の番号で巡回して出発点を1つ選ぶ。archive が空なら選ばない
export function pickStart(archive: Candidate[], round: number): Candidate | undefined {
  if (archive.length === 0) return undefined
  return archive[round % archive.length]
}

// 直前の3周がすべて改善の無い周か。改善は score が 1 の候補が1つでもある周とする。
// 候補の無い周は回っていない周なので、行き詰まりとは数えない
export function stuckModules(history: Candidate[], round: number): boolean {
  const improved = new Set(history.filter((c) => c.score === 1).map((c) => c.round))
  const seen = new Set(history.map((c) => c.round))
  for (let r = round - 3; r < round; r++) {
    if (!seen.has(r)) return false
    if (improved.has(r)) return false
  }
  return true
}

// この周に対象にするモジュール。未探索（archive に score 1 の候補が無い）のモジュールがあれば
// MODULES の順で周の番号から巡回して1つだけ選ぶ。無ければ5つすべて
export function pickUnstuck(archive: Candidate[], round: number): Module[] {
  const explored = new Set(archive.filter((c) => c.score === 1).map((c) => c.module))
  const unexplored = MODULES.filter((module) => !explored.has(module))
  if (unexplored.length === 0) return [...MODULES]
  return [unexplored[round % unexplored.length]]
}

// 提案が課題に固有すぎないかを文字列の規則だけで判定する。空の変更も弾く。
// 課題文（8 文字以上）をそのまま含む変更と、課題の id（t + 数字）を含む変更を弾く
export function critic(changes: string[], tasks: Dialog['tasks']): { ok: boolean; reason: string } {
  if (changes.length === 0) return { ok: false, reason: '変更が空です' }
  for (const change of changes) {
    for (const task of tasks) {
      if (task.statement.length >= 8 && change.includes(task.statement)) {
        return { ok: false, reason: `課題 ${task.id} の課題文を含みます` }
      }
      if (change.includes(task.id)) {
        return { ok: false, reason: `課題 ${task.id} の id を含みます` }
      }
    }
  }
  return { ok: true, reason: '' }
}

// これまでの候補から、捨てる変更の文字列の集合を返す。規則は3つ。
// 改善が無い（その変更を持つ候補がすべて score 0）、費用が増える（score 0 の候補の費用が
// 同じモジュールの score 1 の候補の費用より大きい）、後で不要になった（同じモジュールに後の周の score 1 の候補がある）
export function pruner(history: Candidate[]): Set<string> {
  const dropped = new Set<string>()
  for (const candidate of history) {
    // 同じモジュールの、より後の周の score 1 の候補
    const superseded = history.some(
      (c) => c.module === candidate.module && c.score === 1 && c.round > candidate.round,
    )
    if (superseded) {
      for (const change of candidate.changes) dropped.add(change)
      continue
    }
    // 同じモジュールの score 1 の候補の費用の最大
    const succeeded = history.filter((c) => c.module === candidate.module && c.score === 1)
    const successCost = succeeded.length === 0 ? undefined : Math.max(...succeeded.map((c) => c.cost))
    for (const change of candidate.changes) {
      const owners = history.filter((c) => c.changes.includes(change))
      const neverImproved = owners.every((c) => c.score === 0)
      const costsMore =
        candidate.score === 0 && successCost !== undefined && candidate.cost > successCost
      if (neverImproved || costsMore) dropped.add(change)
    }
  }
  return dropped
}

// 1周を順に進める。費用が上限を超えたら、残りの検証と採用をせずに止める
export async function runRound(options: RoundOptions): Promise<RoundResult> {
  const { round, dialog, propose, check, spent, limitUsd, root, pass, holdout, failures, report } = options
  const weak = weaknesses(dialog)
  // 前の周までの候補。この周で採用した候補を後の提案に混ぜないよう、始めに1回だけ取る
  const archive = listArchive(root)
  const history = [...listCandidates(root), ...archive]
  const start = pickStart(archive, round)
  const failed = failedChanges(history)
  const maxChanges = changeLimit(round)
  // 出発点と archive の候補のコード。archive の並び順で読む
  const code = archive.map((candidate) => ({ id: candidate.id, text: readCode(candidate.id, root) }))
  // この周の提案から除く変更。始めの候補の一覧から1回だけ求める
  const pruned = pruner(history)
  // 直前の3周に改善が無ければ、未探索のモジュールに回す
  const targets = stuckModules(history, round) ? pickUnstuck(archive, round) : [...MODULES]
  // 各モジュールのプロンプトの候補も、この周の間は1回だけ読む
  const promptLists = new Map<Module, PromptCandidate[]>(
    MODULES.map((module) => [module, readPrompts(module, root)]),
  )
  // holdout に渡す課題。積んだ（committed）課題だけにする。
  // 提案の材料の weaknesses は失敗の項目と保留の理由だけなので、積んだ課題は提案に使っていない
  const committed = dialog.tasks.filter((task) => task.state === 'committed')
  const candidates: Candidate[] = []
  const rejected: { module: Module; reason: string }[] = []
  let stopped = false

  for (const module of targets) {
    const id = `${round}-${MODULES.indexOf(module) + 1}`
    const prompts = promptLists.get(module) ?? []
    const proposal = await propose({
      module,
      weaknesses: weak,
      archive,
      round,
      start,
      failed,
      maxChanges,
      prompts: rankPrompts(prompts),
      code,
    })
    // プロンプトの候補があれば、課題ごとの通過で測って Pareto の候補として書く。
    // pass を渡さないときはモデルを呼ばず、通過を空にする
    if (proposal.prompt) {
      const before = spent()
      const passes = pass ? await pass({ module, text: proposal.prompt, passes: {}, cost: 0 }) : {}
      const prompt: PromptCandidate = {
        module,
        text: proposal.prompt,
        passes,
        cost: pass ? spent() - before : 0,
      }
      const next = paretoPrompts([...prompts, prompt])
      writePrompts(module, next, root)
      promptLists.set(module, next)
    }
    // 課題に固有すぎる提案は候補を書かずに弾く
    const judgement = critic(proposal.changes, dialog.tasks)
    if (!judgement.ok) {
      rejected.push({ module, reason: judgement.reason })
      continue
    }
    // pruner が捨てる変更を除いてから上限で切る
    const kept = proposal.changes.filter((change) => !pruned.has(change)).slice(0, maxChanges)
    if (kept.length === 0) {
      rejected.push({ module, reason: 'pruner がすべての変更を捨てた' })
      continue
    }
    const candidate: Candidate = {
      id,
      round,
      module,
      changes: kept,
      score: 0,
      note: proposal.note ?? '',
      cost: 0,
      ...(start ? { parent: start.id } : {}),
      ...(proposal.proposalMaterial === undefined ? {} : { proposalMaterial: proposal.proposalMaterial }),
      ...(proposal.proposalResponse === undefined ? {} : { proposalResponse: proposal.proposalResponse }),
    }
    writeCandidate(candidate, root)

    if (!stopped) {
      if (spent() > limitUsd) {
        stopped = true
      } else {
        const before = spent()
        candidate.score = await check(candidate)
        candidate.cost = spent() - before
        // 採用した候補だけを、提案に使わなかった課題で測る。採否は score だけで決める
        if (candidate.score === 1 && holdout) {
          candidate.holdout = holdout(candidate, committed)
        }
        writeCandidate(candidate, root)
        if (candidate.score === 1) archiveCandidate(candidate.id, root)
      }
    }

    candidates.push(candidate)
    report?.([...candidates])
  }

  // 失敗したテストが渡されたときは、仕様の候補も作って書く。
  // critic・pruner・変更数の上限は仕様の候補には適用しない
  if (failures) {
    for (const candidate of specCandidates(failures, round)) {
      writeCandidate(candidate, root)
      candidates.push(candidate)
      report?.([...candidates])
    }
  }

  return { round, candidates, stopped, start, rejected }
}
