import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Candidate } from '../../shared/evolve.ts'
import { archiveCandidate, evoPaths, listArchive, listCandidates, readCandidate, writeCandidate } from './store.ts'

// HYPH_EVO を一時ディレクトリにした置き場を作る
const evo = () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-evo-'))
  process.env.HYPH_EVO = root
  return root
}

const candidate = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  round: 1,
  module: 'context',
  changes: ['要約の間隔を変える'],
  score: 1,
  note: 'メモ',
  cost: 0,
  ...over,
})

test('HYPH_EVO の下に candidates と archive と prompts のパスを返す', () => {
  const root = evo()
  expect(evoPaths()).toEqual({
    candidates: join(root, 'candidates'),
    archive: join(root, 'archive'),
    prompts: join(root, 'prompts'),
  })
  expect(evoPaths('/tmp/x')).toEqual({
    candidates: '/tmp/x/candidates',
    archive: '/tmp/x/archive',
    prompts: '/tmp/x/prompts',
  })
})

test('書いた候補を読み戻せる', () => {
  evo()
  writeCandidate(candidate('r1-1'))
  expect(existsSync(join(process.env.HYPH_EVO!, 'candidates', 'r1-1.json'))).toBe(true)
  expect(readCandidate('r1-1')).toEqual(candidate('r1-1'))
})

test('listCandidates は候補を id の昇順で返す', () => {
  evo()
  writeCandidate(candidate('r2-1', { round: 2 }))
  writeCandidate(candidate('r1-2'))
  writeCandidate(candidate('r1-1'))
  expect(listCandidates().map((c) => c.id)).toEqual(['r1-1', 'r1-2', 'r2-1'])
})

test('archiveCandidate の後は listCandidates から消えて listArchive に出る', () => {
  evo()
  writeCandidate(candidate('r1-1'))
  writeCandidate(candidate('r1-2'))
  archiveCandidate('r1-1')
  expect(listCandidates().map((c) => c.id)).toEqual(['r1-2'])
  expect(listArchive()).toEqual([candidate('r1-1')])
  expect(existsSync(join(process.env.HYPH_EVO!, 'candidates', 'r1-1.json'))).toBe(false)
  expect(existsSync(join(process.env.HYPH_EVO!, 'archive', 'r1-1.json'))).toBe(true)
})

test('changes が3個を超える候補も書いて読める', () => {
  evo()
  const many = candidate('r1-9', { changes: ['a', 'b', 'c', 'd', 'e'] })
  writeCandidate(many)
  expect(readCandidate('r1-9')).toEqual(many)
  expect(listCandidates()).toEqual([many])
})

test('候補が無いときは空の一覧を返す', () => {
  evo()
  expect(listCandidates()).toEqual([])
  expect(listArchive()).toEqual([])
})
