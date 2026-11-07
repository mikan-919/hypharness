import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Candidate } from '../shared/evolve.ts'
import { createStore } from './store.ts'

const candidate: Candidate = {
  id: '1-1',
  round: 1,
  module: 'context',
  changes: ['変更'],
  score: 0,
  note: '',
  cost: 0,
}

test('初期のスナップショットでは evolution が null', () => {
  const store = createStore()
  expect(store.snapshot().evolution).toBeNull()
})

test('setEvolution は今の値に重ねて保存し、subscribe の購読者に通知する', () => {
  const store = createStore()
  const seen: unknown[] = []
  store.subscribe((dialog) => seen.push(dialog.evolution))

  store.setEvolution({ stage: 'validating', candidates: [candidate] })

  expect(store.snapshot().evolution).toEqual({
    round: 0,
    stage: 'validating',
    spent: 0,
    candidates: [candidate],
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]).toEqual(store.snapshot().evolution)

  store.setEvolution({ round: 1, spent: 0.5 })

  expect(store.snapshot().evolution).toEqual({
    round: 1,
    stage: 'validating',
    spent: 0.5,
    candidates: [candidate],
  })
  expect(seen).toHaveLength(2)
})

test('欄が増える前に保存した課題は、増えた欄を空の値で埋めて読む', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hyph-old-')), 'dialog.json')
  writeFileSync(file, JSON.stringify({ dialog: { tasks: [{ id: 't1', statement: '課題', state: 'committed', attempts: 1, commit: 'abc' }] }, transcripts: {} }))
  expect(createStore(file).snapshot().tasks[0]).toMatchObject({ reason: '', spent: 0, diff: '' })
})

test('前の起動で書いていた途中の文は読み込まない', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hyph-old-')), 'dialog.json')
  writeFileSync(file, JSON.stringify({ dialog: { live: { goal: '**Reviewing**' } }, transcripts: {} }))
  expect(createStore(file).snapshot().live).toEqual({})
})
