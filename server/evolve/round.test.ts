import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialog, Entry, Task } from '../../shared/dialog.ts'
import { MODULES, type Candidate } from '../../shared/evolve.ts'
import { runRound, weaknesses, type ProposeInput } from './round.ts'
import { archiveCandidate, listArchive, listCandidates, writeCandidate } from './store.ts'

// HYPH_EVO を一時ディレクトリにした置き場を作る
const evo = () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-evo-round-'))
  process.env.HYPH_EVO = root
  return root
}

const entry = (id: string, kind: Entry['kind'], text: string): Entry => ({
  id,
  topicId: 't1',
  kind,
  text,
  evidence: '',
})

const task = (id: string, state: Task['state'], reason: string): Task => ({
  id,
  statement: '課題',
  state,
  attempts: 0,
  commit: '',
  reason,
  spent: 0,
  diff: '',
})

const dialog = (over: Partial<Dialog> = {}): Dialog => ({
  topics: [],
  queue: [],
  questions: [],
  entries: [],
  started: false,
  goal: { text: '', version: 0 },
  edits: [],
  tasks: [],
  activity: [],
  live: {},
  halted: '',
  stopping: false,
  ...over,
})

// archive に候補を置く
const putArchive = (root: string, id: string) => {
  const c: Candidate = { id, round: Number(id.split('-')[0]), module: 'context', changes: [id], score: 1, note: '' }
  writeCandidate(c, root)
  archiveCandidate(c.id, root)
  return c
}

// 1周だけ回して、propose に渡った start を返す
const startOfRound = (round: number, root: string): Candidate | undefined => {
  let start: Candidate | undefined
  runRound({
    round,
    dialog: dialog(),
    propose: (input) => {
      start = input.start
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  return start
}

test('weaknesses は失敗の項目と保留の理由を、重複を除いて entries 優先で返す', () => {
  const d = dialog({
    entries: [entry('e1', 'fail', 'A'), entry('e2', 'fact', '無視'), entry('e3', 'fail', 'B'), entry('e4', 'fail', 'A')],
    tasks: [task('k1', 'held', 'B'), task('k2', 'solving', '無視'), task('k3', 'held', 'C')],
  })
  expect(weaknesses(d)).toEqual(['A', 'B', 'C'])
  expect(weaknesses(dialog())).toEqual([])
})

test('propose は5つのモジュールについて1回ずつ呼ばれ、archive に前の周の候補が渡る', () => {
  evo()
  const root = process.env.HYPH_EVO!
  const seen: ProposeInput[] = []
  // 前の周の候補を archive に置く
  const before: Candidate = { id: '1-1', round: 1, module: 'context', changes: ['前'], score: 1, note: '' }
  writeCandidate(before, root)
  archiveCandidate(before.id, root)

  const result = runRound({
    round: 2,
    dialog: dialog({ entries: [entry('e1', 'fail', 'A')] }),
    propose: (input) => {
      seen.push(input)
      return { changes: [`${input.module} の変更`], note: 'メモ' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })

  expect(seen.map((i) => i.module)).toEqual([...MODULES])
  expect(seen.every((i) => i.round === 2)).toBe(true)
  expect(seen.every((i) => i.weaknesses.length === 1 && i.weaknesses[0] === 'A')).toBe(true)
  expect(seen.every((i) => i.archive.length === 1 && i.archive[0].id === '1-1')).toBe(true)
  expect(seen.every((i) => i.start?.id === '1-1')).toBe(true)
  expect(result.round).toBe(2)
  expect(result.stopped).toBe(false)
  expect(result.start?.id).toBe('1-1')
  expect(result.candidates.map((c) => c.id)).toEqual(MODULES.map((_, i) => `2-${i + 1}`))
  expect(result.candidates.map((c) => c.module)).toEqual([...MODULES])
  expect(listCandidates(root).map((c) => c.id)).toEqual(MODULES.map((_, i) => `2-${i + 1}`))
})

test('archive が空のとき、propose に渡る start は undefined', () => {
  const root = evo()
  expect(startOfRound(1, root)).toBeUndefined()
})

test('archive に候補が2件以上あるとき、周を1つ進めると start の id が変わる', () => {
  const root = evo()
  putArchive(root, '1-1')
  putArchive(root, '1-2')
  const first = startOfRound(1, root)
  const second = startOfRound(2, root)
  expect(first?.id).toBeDefined()
  expect(second?.id).toBeDefined()
  expect([first?.id, second?.id].sort()).toEqual(['1-1', '1-2'])
  expect(first?.id).not.toBe(second?.id)
})

test('archive の件数ぶん周を進めると、選ぶ候補が一巡して最初に戻る', () => {
  const root = evo()
  putArchive(root, '1-1')
  putArchive(root, '1-2')
  putArchive(root, '1-3')
  const ids = [1, 2, 3, 4].map((round) => startOfRound(round, root)?.id)
  expect(ids).toEqual(['1-2', '1-3', '1-1', '1-2'])
  expect(new Set(ids.slice(0, 3)).size).toBe(3)
  expect(ids[3]).toBe(ids[0])
})

test('check が 1 を返した候補だけ archive に出て、0 の候補は candidates に残る', () => {
  evo()
  const root = process.env.HYPH_EVO!
  const result = runRound({
    round: 1,
    dialog: dialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: (candidate) => (candidate.module === 'context' || candidate.module === 'completion' ? 1 : 0),
    spent: () => 0,
    limitUsd: 100,
    root,
  })

  expect(listArchive(root).map((c) => c.id)).toEqual(['1-4', '1-5'])
  expect(listCandidates(root).map((c) => c.id)).toEqual(['1-1', '1-2', '1-3'])
  expect(listCandidates(root).map((c) => c.score)).toEqual([0, 0, 0])
  expect(listArchive(root).map((c) => c.score)).toEqual([1, 1])
  expect(result.candidates.map((c) => c.score)).toEqual([0, 0, 0, 1, 1])
  expect(result.candidates.map((c) => c.changes)).toEqual(MODULES.map((m) => [`${m} の変更`]))
})

test('spent が limitUsd を超えたら、その後の check と採用は呼ばれず stopped が true になる', () => {
  evo()
  const root = process.env.HYPH_EVO!
  const checked: string[] = []
  let calls = 0
  const result = runRound({
    round: 3,
    dialog: dialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: (candidate) => {
      checked.push(candidate.id)
      return 1
    },
    // 最初の1回だけ上限以下、その後は上限を超える
    spent: () => (calls++ === 0 ? 1 : 100),
    limitUsd: 50,
    root,
  })

  expect(checked).toEqual(['3-1'])
  expect(listArchive(root).map((c) => c.id)).toEqual(['3-1'])
  expect(result.stopped).toBe(true)
  expect(result.candidates.map((c) => c.score)).toEqual([1, 0, 0, 0, 0])
  // 検証していない候補は candidates に残る
  expect(listCandidates(root).map((c) => c.id)).toEqual(['3-2', '3-3', '3-4', '3-5'])
})

test('上限に達していなければ stopped は false で全件検証する', () => {
  evo()
  const root = process.env.HYPH_EVO!
  const result = runRound({
    round: 1,
    dialog: dialog(),
    propose: () => ({ changes: ['a'], note: 'n' }),
    check: () => 1,
    spent: () => 50,
    limitUsd: 50,
    root,
  })
  expect(result.stopped).toBe(false)
  expect(listArchive(root)).toHaveLength(5)
  expect(listCandidates(root)).toEqual([])
})
