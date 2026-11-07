import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialog } from '../../shared/dialog.ts'
import type { Candidate } from '../../shared/evolve.ts'
import { moduleMaterial, proposeMaterial, runEvolve, readProposal, type EvolveProgress } from './run.ts'
import type { ProposeInput } from './round.ts'
import { archiveCandidate, evoPaths, listArchive, listCandidates, writeCandidate } from './store.ts'

// HYPH_EVO を一時ディレクトリにした置き場を作る
const evo = () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-evo-run-'))
  process.env.HYPH_EVO = root
  return root
}

const emptyDialog = (): Dialog => ({
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
  finished: '',
  evolution: null,
})

test('検証が 1 の候補だけ archive に移り、0 の候補は candidates に残る', async () => {
  const root = evo()
  const result = await runEvolve({
    repo: mkdtempSync(join(tmpdir(), 'hyph-evo-repo-')),
    dialog: emptyDialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: (candidate) => (candidate.module === 'context' || candidate.module === 'completion' ? 1 : 0),
    spent: () => 0,
    limitUsd: 100,
  })

  expect(result.round).toBe(1)
  expect(listArchive(root).map((c) => c.id)).toEqual(['1-4', '1-5'])
  expect(listCandidates(root).map((c) => c.id)).toEqual(['1-1', '1-2', '1-3'])
  expect(listCandidates(root).map((c) => c.score)).toEqual([0, 0, 0])
  expect(listArchive(root).map((c) => c.score)).toEqual([1, 1])
})

test('周の番号は候補とアーカイブにある周の最大に1を足す', async () => {
  const root = evo()
  const prior: Candidate = { id: '3-2', round: 3, module: 'tool-use', changes: ['前'], score: 1, note: '', cost: 0 }
  writeCandidate(prior, root)
  archiveCandidate(prior.id, root)

  const result = await runEvolve({
    repo: mkdtempSync(join(tmpdir(), 'hyph-evo-repo-')),
    dialog: emptyDialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
  })

  expect(result.round).toBe(4)
  expect(result.candidates.map((c) => c.id)).toEqual(['4-1', '4-2', '4-3', '4-4', '4-5'])
  expect(result.start?.id).toBe('3-2')
})

test('費用が上限を超えた後の候補は検証されず candidates に残り、stopped が真になる', async () => {
  const root = evo()
  const checked: string[] = []
  let calls = 0
  const result = await runEvolve({
    repo: mkdtempSync(join(tmpdir(), 'hyph-evo-repo-')),
    dialog: emptyDialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: (candidate) => {
      checked.push(candidate.id)
      return 1
    },
    // 最初の1回だけ上限以下、その後は上限を超える
    spent: () => (calls++ === 0 ? 1 : 100),
    limitUsd: 50,
  })

  expect(checked).toEqual(['1-1'])
  expect(result.stopped).toBe(true)
  expect(result.spent).toBe(100)
  expect(listArchive(root).map((c) => c.id)).toEqual(['1-1'])
  expect(listCandidates(root).map((c) => c.id)).toEqual(['1-2', '1-3', '1-4', '1-5'])
})

test('archive に置いた候補の score・cost・note が propose に届く', async () => {
  const root = evo()
  const prior: Candidate = {
    id: '1-2',
    round: 1,
    module: 'tool-use',
    changes: ['前の変更'],
    score: 1,
    note: '前の注記',
    cost: 0.5,
  }
  writeCandidate(prior, root)
  archiveCandidate(prior.id, root)

  let seen: ProposeInput | undefined
  await runEvolve({
    repo: mkdtempSync(join(tmpdir(), 'hyph-evo-repo-')),
    dialog: emptyDialog(),
    propose: (input) => {
      if (!seen) seen = input
      return { changes: [`${input.module} の変更`], note: '' }
    },
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
  })

  expect(seen?.archive.map((c) => [c.id, c.score, c.cost, c.note])).toEqual([['1-2', 1, 0.5, '前の注記']])
  expect(seen?.start?.score).toBe(1)
  expect(seen?.start?.cost).toBe(0.5)
  expect(seen?.start?.note).toBe('前の注記')
})

test('材料の archive と start に score・cost・holdout・note が入り、holdout が未測定なら入らない', () => {
  const root = evo()
  const measured: Candidate = {
    id: '1-1',
    round: 1,
    module: 'tool-use',
    changes: ['a'],
    score: 1,
    note: 'n',
    cost: 0.5,
    holdout: 1,
  }
  const unmeasured: Candidate = {
    id: '1-2',
    round: 1,
    module: 'context',
    changes: ['b'],
    score: 0,
    note: '',
    cost: 0,
  }
  const input: ProposeInput = {
    module: 'tool-use',
    weaknesses: [],
    archive: [measured, unmeasured],
    round: 2,
    start: unmeasured,
    failed: [],
    maxChanges: 3,
    prompts: [],
    code: [{ id: '1-1', text: 'code text' }],
  }

  const material = proposeMaterial(input, root)

  expect(material.archive[0]).toEqual({
    id: '1-1',
    module: 'tool-use',
    changes: ['a'],
    score: 1,
    cost: 0.5,
    note: 'n',
    holdout: 1,
  })
  expect(material.archive[1]).toEqual({
    id: '1-2',
    module: 'context',
    changes: ['b'],
    score: 0,
    cost: 0,
    note: '',
  })
  expect(Array.isArray(material.start)).toBe(false)
  const start = material.start as { score: number }
  expect('holdout' in start).toBe(false)
  expect(start.score).toBe(0)
  expect(material.paths).toEqual(evoPaths(root))
  expect(material.paths.candidates.endsWith(join('candidates'))).toBe(true)
  expect(material.paths.archive.endsWith(join('archive'))).toBe(true)
  expect(material.code).toEqual([{ id: '1-1', text: 'code text' }])
})

test('JSON として読めない応答は changes を空にし、理由を note に書く', () => {
  const result = readProposal('これは JSON ではありません')
  expect(result.changes).toEqual([])
  expect(result.note).toContain('JSON として読めませんでした')
})

test('JSON の応答から changes と note を読む', () => {
  expect(readProposal('{"changes": ["a", "b"], "note": "n"}')).toEqual({ changes: ['a', 'b'], note: 'n' })
})

test('onProgress は proposing から validating を経て done になり、最後に round・spent・candidates が入る', async () => {
  const root = evo()
  const events: EvolveProgress[] = []
  const result = await runEvolve({
    repo: mkdtempSync(join(tmpdir(), 'hyph-evo-repo-')),
    dialog: emptyDialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: () => 1,
    spent: () => 2,
    limitUsd: 100,
    onProgress: (progress) => events.push({ ...progress, candidates: [...progress.candidates] }),
  })

  expect(events[0].stage).toBe('proposing')
  expect(events[0].round).toBe(1)
  expect(events[0].candidates).toEqual([])
  expect(events.filter((e) => e.stage === 'validating').map((e) => e.candidates.length)).toEqual([1, 2, 3, 4, 5])
  const last = events.at(-1)!
  expect(last.stage).toBe('done')
  expect(last.round).toBe(result.round)
  expect(last.spent).toBe(result.spent)
  expect(last.candidates.map((c) => c.id)).toEqual(result.candidates.map((c) => c.id))
  expect(listArchive(root).map((c) => c.id)).toEqual(['1-1', '1-2', '1-3', '1-4', '1-5'])
})

test('提案役の材料に、統合ブランチの先端の仕様と、仕様に挙がったソースと、ADR の題が入る', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hyph-material-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true })
  mkdirSync(join(dir, 'harness'))
  writeFileSync(join(dir, 'docs', 'specs', 'context.md'), '# context\n\nコード: `harness/ctx.ts` と `harness/none.ts`。\n')
  writeFileSync(join(dir, 'docs', 'adr', '0001-local.md'), '# 0001 ローカルだけで動かす\n')
  writeFileSync(join(dir, 'harness', 'ctx.ts'), '統合ブランチの版\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  git('branch', 'hypharness/integration')
  writeFileSync(join(dir, 'harness', 'ctx.ts'), '作業ツリーの版\n')
  const material = moduleMaterial(dir, 'context')
  expect(material.sources).toEqual([{ path: 'harness/ctx.ts', text: '統合ブランチの版\n' }])
  expect(material.decisions).toEqual(['0001 ローカルだけで動かす'])
  expect(material.spec).toContain('# context')
})
