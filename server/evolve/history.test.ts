import { expect, test } from 'bun:test'
import type { Evolution } from '../../shared/dialog.ts'
import type { Candidate } from '../../shared/evolve.ts'
import { candidatesInEvolutionRound, evolutionCandidateView, evolutionRoundList } from '../../shared/evolution-history.ts'

const candidate = (id: string, round: number, over: Partial<Candidate> = {}): Candidate => ({
  id,
  round,
  module: 'context',
  changes: [`change ${id}`],
  score: 0,
  note: `note ${id}`,
  cost: 0,
  ...over,
})

const evolution = (round: number, candidates: Candidate[] = []): Evolution => ({
  round,
  stage: 'validating',
  spent: 0.25,
  candidates,
})

test('周一覧に Dialog.evolution と保存済み候補の周を重複なく含める', () => {
  expect(
    evolutionRoundList(evolution(4), [candidate('2-1', 2), candidate('1-1', 1), candidate('2-2', 2)]),
  ).toEqual([1, 2, 4])
  expect(evolutionRoundList(null, [])).toEqual([])
})

test('選択した周の候補だけを返し、進行中の同じ id は Dialog の値を使う', () => {
  const saved = [
    candidate('1-1', 1),
    candidate('2-1', 2, { note: '保存された値' }),
    candidate('3-1', 3),
  ]
  const current = evolution(2, [candidate('2-1', 2, { note: '進行中の値' }), candidate('2-2', 2)])

  expect(candidatesInEvolutionRound(2, current, saved)).toEqual([
    candidate('2-1', 2, { note: '進行中の値' }),
    candidate('2-2', 2),
  ])
  expect(candidatesInEvolutionRound(1, current, saved)).toEqual([candidate('1-1', 1)])
  expect(candidatesInEvolutionRound(4, current, saved)).toEqual([])
})

test('詳細ログの無い旧形式候補も保存済み項目を残し、未記録項目を区別する', () => {
  const old = candidate('1-1', 1, {
    changes: ['保存された変更'],
    note: '保存されたメモ',
    commit: 'abc123456789',
  })
  delete (old as Partial<Candidate>).diff
  delete (old as Partial<Candidate>).checkOutput

  expect(evolutionCandidateView(old)).toEqual({
    id: '1-1',
    module: 'context',
    changes: ['保存された変更'],
    score: 0,
    commit: 'abc123456789',
    note: '保存されたメモ',
    diff: null,
    checkOutput: null,
    proposalMaterial: null,
    proposalResponse: null,
  })

  const fullText = 'detail'.repeat(2_000)
  const withDetails = candidate('2-1', 2, {
    note: fullText,
    diff: fullText,
    checkOutput: { stdout: fullText, stderr: fullText },
    proposalMaterial: `材料\n${fullText}`,
    proposalResponse: `応答\n${fullText}`,
  })
  expect(evolutionCandidateView(withDetails)).toEqual({
    id: '2-1',
    module: 'context',
    changes: ['change 2-1'],
    score: 0,
    commit: null,
    note: fullText,
    diff: fullText,
    checkOutput: { stdout: fullText, stderr: fullText },
    proposalMaterial: `材料\n${fullText}`,
    proposalResponse: `応答\n${fullText}`,
  })

  expect(evolutionCandidateView(candidate('3-1', 3, { note: '' })).note).toBe('')
  const withoutNote = candidate('4-1', 4)
  delete (withoutNote as Partial<Candidate>).note
  expect(evolutionCandidateView(withoutNote).note).toBeNull()
})
