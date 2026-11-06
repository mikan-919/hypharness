// 自己改良の1周（最終目的の 6 の 1〜6）。弱点を集め、モジュールごとに候補を作り、検証して、通ったものだけを残す。
import type { Dialog } from '../../shared/dialog.ts'
import { MODULES, type Candidate, type Module } from '../../shared/evolve.ts'
import { archiveCandidate, listArchive, listCandidates, writeCandidate } from './store.ts'

// 提案に渡す材料。archive は前の周までの採用済みの候補、start はこの周の出発点。
// failed は検証に通らなかった変更の履歴、maxChanges は1つの候補に残す変更の数の上限
export type ProposeInput = {
  module: Module
  weaknesses: string[]
  archive: Candidate[]
  round: number
  start?: Candidate
  failed: string[]
  maxChanges: number
}

// 提案の返り値。id・round・module・score は runRound が入れる
export type Proposal = {
  changes: string[]
  note?: string
}

export type RoundOptions = {
  round: number
  dialog: Dialog
  propose: (input: ProposeInput) => Proposal | Promise<Proposal>
  check: (candidate: Candidate) => 0 | 1 | Promise<0 | 1>
  spent: () => number
  limitUsd: number
  root?: string
}

export type RoundResult = {
  round: number
  candidates: Candidate[]
  stopped: boolean
  start?: Candidate
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

// 1周を順に進める。費用が上限を超えたら、残りの検証と採用をせずに止める
export async function runRound(options: RoundOptions): Promise<RoundResult> {
  const { round, dialog, propose, check, spent, limitUsd, root } = options
  const weak = weaknesses(dialog)
  // 前の周までの候補。この周で採用した候補を後の提案に混ぜないよう、始めに1回だけ取る
  const archive = listArchive(root)
  const history = [...listCandidates(root), ...archive]
  const start = pickStart(archive, round)
  const failed = failedChanges(history)
  const maxChanges = changeLimit(round)
  // 直前の3周に改善が無ければ、未探索のモジュールに回す
  const targets = stuckModules(history, round) ? pickUnstuck(archive, round) : [...MODULES]
  const candidates: Candidate[] = []
  let stopped = false

  for (const module of targets) {
    const id = `${round}-${MODULES.indexOf(module) + 1}`
    const proposal = await propose({ module, weaknesses: weak, archive, round, start, failed, maxChanges })
    const candidate: Candidate = {
      id,
      round,
      module,
      changes: proposal.changes.slice(0, maxChanges),
      score: 0,
      note: proposal.note ?? '',
    }
    writeCandidate(candidate, root)

    if (!stopped) {
      if (spent() > limitUsd) {
        stopped = true
      } else {
        candidate.score = await check(candidate)
        writeCandidate(candidate, root)
        if (candidate.score === 1) archiveCandidate(candidate.id, root)
      }
    }

    candidates.push(candidate)
  }

  return { round, candidates, stopped, start }
}
