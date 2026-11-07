import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Dialog } from '../../shared/dialog.ts'
import { runRound } from './round.ts'
import { applySpec, specCandidates, specOrder, type Failure } from './spec.ts'
import { listCandidates } from './store.ts'

// docs/specs を持つ一時ディレクトリを作る
const worktree = (files: Record<string, string>) => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-spec-'))
  mkdirSync(join(root, 'docs/specs'), { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(root, 'docs/specs', name), text)
  }
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
})

test('同じモジュールでも失敗の種類が違えば別の候補になる', () => {
  const failures: Failure[] = [
    { test: 'A', module: 'tool-use', kind: 'タイムアウト' },
    { test: 'B', module: 'tool-use', kind: '引数' },
  ]
  const candidates = specCandidates(failures, 1)
  expect(candidates).toHaveLength(2)
  expect(candidates.map((c) => c.module)).toEqual(['tool-use', 'tool-use'])
  expect(candidates.map((c) => c.kind)).toEqual(['タイムアウト', '引数'])
  expect(candidates[0].changes).not.toEqual(candidates[1].changes)
})

test('同じモジュール・同じ種類の失敗は1つの候補にまとまり、テスト名が全部入る', () => {
  const failures: Failure[] = [
    { test: 'A', module: 'context', kind: '要約' },
    { test: 'B', module: 'context', kind: '要約' },
  ]
  const candidates = specCandidates(failures, 2)
  expect(candidates).toHaveLength(1)
  expect(candidates[0].kind).toBe('要約')
  expect(candidates[0].tests).toEqual(['A', 'B'])
  expect(candidates[0].changes.join('\n')).toContain('A')
  expect(candidates[0].changes.join('\n')).toContain('B')
})

test('候補は callee 先に並び、agent-loop が最後になる', () => {
  const failures: Failure[] = [
    { test: 'A', module: 'agent-loop', kind: 'ループ' },
    { test: 'B', module: 'tool-use', kind: '引数' },
  ]
  const candidates = specCandidates(failures, 1)
  expect(candidates.map((c) => c.module)).toEqual(['tool-use', 'agent-loop'])
  expect(specOrder().at(-1)).toBe('agent-loop')
})

test('適用すると該当する箇条書きが変わり、コードの行と他のモジュールは変わらない', () => {
  const toolUse = [
    '# tool-use',
    '',
    '- タイムアウト の扱い。',
    '- その他の振る舞い。',
    '',
    'コード: `harness/agent.ts`。',
    '',
  ].join('\n')
  const context = '# context\n\n- 要約。\n\nコード: `harness/ctx.ts`。\n'
  const root = worktree({ 'tool-use.md': toolUse, 'context.md': context })
  const [candidate] = specCandidates([{ test: 'T1', module: 'tool-use', kind: 'タイムアウト' }], 1)

  expect(applySpec(candidate, root)).toBe(true)

  const updated = readFileSync(join(root, 'docs/specs/tool-use.md'), 'utf8')
  expect(updated).toContain(candidate.changes[0])
  expect(updated).not.toContain('タイムアウト の扱い。')
  expect(updated).toContain('コード: `harness/agent.ts`。')
  expect(readFileSync(join(root, 'docs/specs/context.md'), 'utf8')).toBe(context)
})

test('対応する箇条書きが無ければ末尾に足す', () => {
  const toolUse = '# tool-use\n\n- 振る舞い。\n\nコード: `harness/agent.ts`。\n'
  const root = worktree({ 'tool-use.md': toolUse })
  const [candidate] = specCandidates([{ test: 'T1', module: 'tool-use', kind: '引数' }], 1)

  expect(applySpec(candidate, root)).toBe(true)
  const updated = readFileSync(join(root, 'docs/specs/tool-use.md'), 'utf8')
  expect(updated).toContain('- 振る舞い。')
  expect(updated).toContain(candidate.changes[0])
  const lines = updated.split('\n')
  expect(lines.indexOf(candidate.changes[0])).toBeLessThan(lines.findIndex((l) => l.startsWith('コード:')))
})

test('ファイルが無ければ作らない', () => {
  const root = worktree({})
  const [candidate] = specCandidates([{ test: 'T1', module: 'completion', kind: '停止' }], 1)
  expect(applySpec(candidate, root)).toBe(false)
})

test('runRound に failures を渡すと仕様の候補も candidates に含めて保存する', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-spec-round-'))
  const result = await runRound({
    round: 1,
    dialog: emptyDialog(),
    propose: (input) => ({ changes: [`${input.module} の変更`], note: '' }),
    check: () => 0,
    spent: () => 0,
    limitUsd: 100,
    root,
    failures: [{ test: 'T1', module: 'tool-use', kind: '引数' }],
  })
  const spec = result.candidates.filter((c) => c.module === 'tool-use' && c.changes[0].includes('引数'))
  expect(spec).toHaveLength(1)
  expect(listCandidates(root).map((c) => c.id)).toContain(spec[0].id)
})
