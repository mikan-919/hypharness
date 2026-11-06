import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialog, Entry, Task } from '../../shared/dialog.ts'
import { MODULES, type Candidate, type Module, type PromptCandidate } from '../../shared/evolve.ts'
import { critic, pruner, runRound, weaknesses, type ProposeInput } from './round.ts'
import { readPrompts } from './prompts.ts'
import { archiveCandidate, listArchive, listCandidates, readCode, writeCandidate } from './store.ts'

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

// 候補を candidates に置く。score が 1 のものは archive に移す
const put = (root: string, over: Partial<Candidate> & { id: string }) => {
  const c: Candidate = {
    round: Number(over.id.split('-')[0]),
    module: 'context',
    changes: [],
    score: 0,
    note: '',
    cost: 0,
    ...over,
  }
  writeCandidate(c, root)
  if (c.score === 1) archiveCandidate(c.id, root)
  return c
}

// archive に候補を置く
const putArchive = (root: string, id: string) => put(root, { id, changes: [id], score: 1 })

// candidates に候補を置く
const putCandidate = (root: string, id: string, changes: string[], score: 0 | 1) =>
  put(root, { id, changes, score })

// 1周ぶんの候補を置く。score が 1 のものは archive に移す
const putRound = (root: string, round: number, modules: readonly Module[], score: 0 | 1) => {
  for (const module of modules) {
    put(root, {
      id: `${round}-${MODULES.indexOf(module) + 1}`,
      round,
      module,
      changes: ['変更'],
      score,
    })
  }
}

// 1周を回して、propose に渡ったモジュールを順に返す
const modulesOfRound = async (round: number, root: string): Promise<Module[]> => {
  const seen: Module[] = []
  await runRound({
    round,
    dialog: dialog(),
    propose: (input) => {
      seen.push(input.module)
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  return seen
}

// 1周だけ回して、propose に渡った start を返す
const startOfRound = async (round: number, root: string): Promise<Candidate | undefined> => {
  let start: Candidate | undefined
  await runRound({
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

test('propose は5つのモジュールについて1回ずつ呼ばれ、archive に前の周の候補が渡る', async () => {
  evo()
  const root = process.env.HYPH_EVO!
  const seen: ProposeInput[] = []
  // 前の周の候補を archive に置く
  putArchive(root, '1-1')

  const result = await runRound({
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

test('archive が空のとき、propose に渡る start は undefined', async () => {
  const root = evo()
  expect(await startOfRound(1, root)).toBeUndefined()
})

test('archive に候補が2件以上あるとき、周を1つ進めると start の id が変わる', async () => {
  const root = evo()
  putArchive(root, '1-1')
  putArchive(root, '1-2')
  const first = await startOfRound(1, root)
  const second = await startOfRound(2, root)
  expect(first?.id).toBeDefined()
  expect(second?.id).toBeDefined()
  expect([first?.id, second?.id].sort()).toEqual(['1-1', '1-2'])
  expect(first?.id).not.toBe(second?.id)
})

test('archive の件数ぶん周を進めると、選ぶ候補が一巡して最初に戻る', async () => {
  const root = evo()
  putArchive(root, '1-1')
  putArchive(root, '1-2')
  putArchive(root, '1-3')
  const ids: (string | undefined)[] = []
  for (const round of [1, 2, 3, 4]) ids.push((await startOfRound(round, root))?.id)
  expect(ids).toEqual(['1-2', '1-3', '1-1', '1-2'])
  expect(new Set(ids.slice(0, 3)).size).toBe(3)
  expect(ids[3]).toBe(ids[0])
})

test('check が 1 を返した候補だけ archive に出て、0 の候補は candidates に残る', async () => {
  evo()
  const root = process.env.HYPH_EVO!
  const result = await runRound({
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

test('spent が limitUsd を超えたら、その後の check と採用は呼ばれず stopped が true になる', async () => {
  evo()
  const root = process.env.HYPH_EVO!
  const checked: string[] = []
  let calls = 0
  const result = await runRound({
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

test('上限に達していなければ stopped は false で全件検証する', async () => {
  evo()
  const root = process.env.HYPH_EVO!
  const result = await runRound({
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

test('直前の3周がすべて改善なしで未探索のモジュールがあるとき、未探索の1つだけを対象にする', async () => {
  const root = evo()
  for (const round of [1, 2, 3]) putRound(root, round, MODULES, 0)
  // archive が空なので5つすべてが未探索。周の番号 4 から巡回して MODULES[4]
  const result = await runRound({
    round: 4,
    dialog: dialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.map((c) => c.module)).toEqual([MODULES[4]])
  expect(result.candidates.map((c) => c.id)).toEqual([`4-${MODULES.length}`])
  expect(listCandidates(root).filter((c) => c.round === 4).map((c) => c.id)).toEqual([`4-${MODULES.length}`])
})

test('直前の3周のどれかに改善があったときは5つすべてを対象にする', async () => {
  const root = evo()
  putRound(root, 1, MODULES, 0)
  putRound(root, 2, MODULES, 1)
  putRound(root, 3, MODULES, 0)
  expect(await modulesOfRound(4, root)).toEqual([...MODULES])
})

test('未探索のモジュールが無いときは5つすべてを対象にする', async () => {
  const root = evo()
  putRound(root, 1, MODULES, 1)
  for (const round of [2, 3, 4]) putRound(root, round, MODULES, 0)
  expect(await modulesOfRound(5, root)).toEqual([...MODULES])
})

test('未探索が複数あるとき、周の番号を1つ進めると選ばれるモジュールが変わる', async () => {
  const root = evo()
  // 周 9 で agent-loop と tool-use を探索済みにして、未探索を3つにする
  putRound(root, 9, [MODULES[0], MODULES[1]], 1)
  for (const round of [1, 2, 3, 4]) putRound(root, round, MODULES, 0)
  const first = await modulesOfRound(4, root)
  const second = await modulesOfRound(5, root)
  expect(first).toEqual([MODULES[2 + (4 % 3)]])
  expect(second).toEqual([MODULES[2 + (5 % 3)]])
  expect(first).not.toEqual(second)
})

test('score が 0 の候補の changes が propose の failed に入り、同じ文字列は1つになる', async () => {
  const root = evo()
  putCandidate(root, '1-1', ['A', 'B'], 0)
  putCandidate(root, '1-2', ['B', 'C'], 0)
  putArchive(root, '1-3')
  const seen: ProposeInput[] = []
  await runRound({
    round: 2,
    dialog: dialog(),
    propose: (input) => {
      seen.push(input)
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(seen.every((i) => i.failed.join(',') === 'A,B,C')).toBe(true)
})

test('propose に渡る code は start と archive の候補の id と本文を持ち、並びは archive と同じ', async () => {
  const root = evo()
  putArchive(root, '1-1')
  putArchive(root, '1-2')
  const seen: ProposeInput[] = []
  await runRound({
    round: 2,
    dialog: dialog(),
    propose: (input) => {
      seen.push(input)
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  const archive = listArchive(root)
  const expected = archive.map((c) => ({ id: c.id, text: readCode(c.id, root) }))
  expect(expected.map((e) => e.id)).toEqual(['1-1', '1-2'])
  expect(seen.every((i) => JSON.stringify(i.code) === JSON.stringify(expected))).toBe(true)
  expect(seen[0].code).toEqual([
    { id: '1-1', text: readCode('1-1', root) },
    { id: '1-2', text: readCode('1-2', root) },
  ])
  expect(seen[0].start?.id).toBe(seen[0].code[0].id)
  expect(seen[0].code[0].text).toContain('module: context')
})

test('コードのファイルが無い候補は propose に渡る code の text が空文字になる', async () => {
  const root = evo()
  putArchive(root, '1-1')
  rmSync(join(root, 'code', '1-1.md'))
  const seen: ProposeInput[] = []
  await runRound({
    round: 2,
    dialog: dialog(),
    propose: (input) => {
      seen.push(input)
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(seen.every((i) => i.code.length === 1 && i.code[0].id === '1-1' && i.code[0].text === '')).toBe(true)
})

test('周の番号が 10 以下のとき、changes が4個以上でも候補に残るのは先頭3個', async () => {
  const root = evo()
  const result = await runRound({
    round: 10,
    dialog: dialog(),
    propose: () => ({ changes: ['a', 'b', 'c', 'd', 'e'], note: 'メモ' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.map((c) => c.changes)).toEqual(MODULES.map(() => ['a', 'b', 'c']))
  // note は提案の値をそのまま使う
  expect(result.candidates.map((c) => c.note)).toEqual(MODULES.map(() => 'メモ'))
  expect(listCandidates(root).map((c) => c.changes)).toEqual(MODULES.map(() => ['a', 'b', 'c']))
})

test('周の番号が 11 以上のとき、候補に残るのは先頭1個', async () => {
  const root = evo()
  const result = await runRound({
    round: 11,
    dialog: dialog(),
    propose: (input) => {
      expect(input.maxChanges).toBe(1)
      return { changes: ['a', 'b', 'c', 'd'], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.map((c) => c.changes)).toEqual(MODULES.map(() => ['a']))
  expect(listCandidates(root).map((c) => c.changes)).toEqual(MODULES.map(() => ['a']))
})

test('空の changes は critic が弾く', () => {
  expect(critic([], []).ok).toBe(false)
})

test('課題文を含む提案は rejected に入り、候補が作られない', async () => {
  const root = evo()
  const statement = '保存した本文を画面に出す'
  const result = await runRound({
    round: 1,
    dialog: dialog({ tasks: [{ ...task('t1', 'solving', ''), statement }] }),
    propose: () => ({ changes: [`${statement} ようにする`], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates).toEqual([])
  expect(result.rejected.map((r) => r.reason)).toEqual(MODULES.map(() => '課題 t1 の課題文を含みます'))
  expect(listCandidates(root)).toEqual([])
})

test('課題 id を含む提案は rejected に入る', async () => {
  const root = evo()
  const result = await runRound({
    round: 1,
    dialog: dialog({ tasks: [task('t12', 'solving', '')] }),
    propose: () => ({ changes: ['t12 の修正を入れる'], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates).toEqual([])
  expect(result.rejected.map((r) => r.reason)).toEqual(MODULES.map(() => '課題 t12 の id を含みます'))
  expect(listCandidates(root)).toEqual([])
})

test('score が 0 の候補にしか出てこない変更は次の周の changes から除かれる', async () => {
  const root = evo()
  putCandidate(root, '1-4', ['X'], 0)
  const result = await runRound({
    round: 2,
    dialog: dialog(),
    propose: () => ({ changes: ['X', 'Y'], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.every((c) => c.changes.join(',') === 'Y')).toBe(true)
  expect(pruner([put(root, { id: '9-4', changes: ['X'], score: 0 })]).has('X')).toBe(true)
})

test('同じモジュールの後の周に score が 1 の候補があれば、前の候補の変更が除かれる', async () => {
  const root = evo()
  put(root, { id: '1-4', round: 1, module: 'context', changes: ['X'], score: 0 })
  put(root, { id: '2-4', round: 2, module: 'context', changes: ['W'], score: 1 })
  const result = await runRound({
    round: 3,
    dialog: dialog(),
    propose: () => ({ changes: ['X', 'Y'], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.every((c) => c.changes.join(',') === 'Y')).toBe(true)
})

test('score が 0 の候補の費用が同じモジュールの score が 1 の候補より大きいとき、その変更が除かれる', async () => {
  const root = evo()
  put(root, { id: '1-4', round: 1, module: 'context', changes: ['C'], score: 0, cost: 10 })
  put(root, { id: '1-5', round: 1, module: 'context', changes: ['C'], score: 1, cost: 1 })
  const result = await runRound({
    round: 2,
    dialog: dialog(),
    propose: () => ({ changes: ['C', 'E'], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(result.candidates.every((c) => c.changes.join(',') === 'E')).toBe(true)
})

test('check の前後で spent の差を取り、候補の cost に書く', async () => {
  const root = evo()
  let calls = 0
  const result = await runRound({
    round: 1,
    dialog: dialog(),
    propose: () => ({ changes: ['a'], note: '' }),
    check: () => 0,
    // 1件目の検証の前は 0、後は 2。以降は 2 のまま
    spent: () => (calls++ < 2 ? 0 : 2),
    limitUsd: 100,
    root,
  })
  expect(result.candidates.map((c) => c.cost)).toEqual([2, 0, 0, 0, 0])
  expect(listCandidates(root).map((c) => c.cost)).toEqual([2, 0, 0, 0, 0])
})

test('propose が prompt を返すと prompts/<module>.json に書き、次の周の propose にその候補が渡る', async () => {
  const root = evo()
  await runRound({
    round: 1,
    dialog: dialog(),
    propose: (input) => ({
      changes: [`${input.module} の変更`],
      note: '',
      prompt: input.module === 'context' ? 'P1' : undefined,
    }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    pass: () => ({ t1: 1 }),
    root,
  })

  expect(readPrompts('context', root)).toEqual([
    { module: 'context', text: 'P1', passes: { t1: 1 }, cost: 0 },
  ])
  expect(readPrompts('completion', root)).toEqual([])

  const seen: PromptCandidate[][] = []
  await runRound({
    round: 2,
    dialog: dialog(),
    propose: (input) => {
      if (input.module === 'context') seen.push(input.prompts)
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(seen).toHaveLength(1)
  expect(seen[0].map((p) => p.text)).toEqual(['P1'])
})

test('同じ text のプロンプトを2周にわたって提案しても、prompts/<module>.json の候補は1つになる', async () => {
  const root = evo()
  for (const round of [1, 2]) {
    await runRound({
      round,
      dialog: dialog(),
      propose: () => ({ changes: [`r${round} の変更`], note: '', prompt: 'P' }),
      check: () => 0,
      spent: () => 0,
      limitUsd: 100,
      pass: () => ({ t1: 1 }),
      root,
    })
  }
  expect(readPrompts('context', root)).toHaveLength(1)
})

test('pass を省略したとき、プロンプトの通過は空で費用は 0 になる', async () => {
  const root = evo()
  await runRound({
    round: 1,
    dialog: dialog(),
    propose: () => ({ changes: ['a'], note: '', prompt: 'P' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
  })
  expect(readPrompts('context', root)).toEqual([
    { module: 'context', text: 'P', passes: {}, cost: 0 },
  ])
})

test('測ったプロンプトは既存の候補と合わせて Pareto に通してから書く', async () => {
  const root = evo()
  await runRound({
    round: 1,
    dialog: dialog(),
    propose: () => ({ changes: ['a'], note: '', prompt: 'A' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    pass: () => ({ t1: 1, t2: 1 }),
    root,
  })
  await runRound({
    round: 2,
    dialog: dialog(),
    propose: () => ({ changes: ['b'], note: '', prompt: 'B' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    pass: () => ({ t1: 1 }),
    root,
  })
  // A は B を全課題で同等以上かつ1つで上回るので B は残らない
  expect(readPrompts('context', root).map((p) => p.text)).toEqual(['A'])
})
