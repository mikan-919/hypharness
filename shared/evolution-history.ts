import type { Evolution } from './dialog.ts'
import type { Candidate } from './evolve.ts'

// 画面で選べる周。進行中の Dialog と候補の保存先を合わせ、周の番号順で返す
export function evolutionRoundList(evolution: Evolution | null, saved: Candidate[]): number[] {
  const rounds = new Set(saved.map((candidate) => candidate.round))
  if (evolution) rounds.add(evolution.round)
  return [...rounds].sort((a, b) => a - b)
}

// 選んだ周だけを返す。保存先に同じ id があれば、進行中の Dialog の候補を優先する
export function candidatesInEvolutionRound(
  round: number,
  evolution: Evolution | null,
  saved: Candidate[],
): Candidate[] {
  const candidates = new Map<string, Candidate>()
  for (const candidate of saved) {
    if (candidate.round === round) candidates.set(candidate.id, candidate)
  }
  if (evolution?.round === round) {
    for (const candidate of evolution.candidates) candidates.set(candidate.id, candidate)
  }
  return [...candidates.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// 詳細ログが追加される前の形式も、保存済み情報と未記録の項目を区別して扱う
export function evolutionCandidateView(candidate: Candidate) {
  return {
    id: candidate.id,
    module: candidate.module,
    changes: Array.isArray(candidate.changes) ? candidate.changes : [],
    score: candidate.score,
    commit: candidate.commit ?? null,
    note: typeof candidate.note === 'string' ? candidate.note : null,
    diff: typeof candidate.diff === 'string' ? candidate.diff : null,
    checkOutput:
      candidate.checkOutput &&
      typeof candidate.checkOutput.stdout === 'string' &&
      typeof candidate.checkOutput.stderr === 'string'
        ? candidate.checkOutput
        : null,
  }
}
