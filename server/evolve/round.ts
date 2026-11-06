// 自己改良の1周（最終目的の 6 の 1〜6）。弱点を集め、モジュールごとに候補を作り、検証して、通ったものだけを残す。
import type { Dialog } from '../../shared/dialog.ts'
import { MODULES, type Candidate, type Module } from '../../shared/evolve.ts'
import { archiveCandidate, listArchive, writeCandidate } from './store.ts'

// 提案に渡す材料。archive は前の周までの採用済みの候補
export type ProposeInput = {
  module: Module
  weaknesses: string[]
  archive: Candidate[]
  round: number
}

// 提案の返り値。id・round・module・score は runRound が入れる
export type Proposal = {
  changes: string[]
  note?: string
}

export type RoundOptions = {
  round: number
  dialog: Dialog
  propose: (input: ProposeInput) => Proposal
  check: (candidate: Candidate) => 0 | 1
  spent: () => number
  limitUsd: number
  root?: string
}

export type RoundResult = {
  round: number
  candidates: Candidate[]
  stopped: boolean
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

// 1周を順に進める。費用が上限を超えたら、残りの検証と採用をせずに止める
export function runRound(options: RoundOptions): RoundResult {
  const { round, dialog, propose, check, spent, limitUsd, root } = options
  const weak = weaknesses(dialog)
  // 前の周までの候補。この周で採用した候補を後の提案に混ぜないよう、始めに1回だけ取る
  const archive = listArchive(root)
  const candidates: Candidate[] = []
  let stopped = false

  for (const [index, module] of MODULES.entries()) {
    const id = `${round}-${index + 1}`
    const proposal = propose({ module, weaknesses: weak, archive, round })
    const candidate: Candidate = {
      id,
      round,
      module,
      changes: proposal.changes,
      score: 0,
      note: proposal.note ?? '',
    }
    writeCandidate(candidate, root)

    if (!stopped) {
      if (spent() > limitUsd) {
        stopped = true
      } else {
        candidate.score = check(candidate)
        writeCandidate(candidate, root)
        if (candidate.score === 1) archiveCandidate(candidate.id, root)
      }
    }

    candidates.push(candidate)
  }

  return { round, candidates, stopped }
}
