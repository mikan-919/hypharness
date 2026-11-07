import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PromptCandidate } from '../../shared/evolve.ts'
import { readPrompts, writePrompts } from './prompts.ts'

// HYPH_EVO を一時ディレクトリにした置き場を作る
const evo = () => {
  const root = mkdtempSync(join(tmpdir(), 'hyph-evo-prompts-'))
  process.env.HYPH_EVO = root
  return root
}

const prompt = (text: string, passes: Record<string, 0 | 1>, cost = 0): PromptCandidate => ({
  module: 'context',
  text,
  passes,
  cost,
})

test('ファイルが無ければ空の配列を返す', () => {
  const root = evo()
  expect(readPrompts('context', root)).toEqual([])
})

test('書いたプロンプトの候補を読み戻せる', () => {
  const root = evo()
  const list = [prompt('A', { t1: 1 }), prompt('B', { t2: 1 }, 0.5)]
  writePrompts('context', list, root)
  expect(existsSync(join(root, 'prompts', 'context.json'))).toBe(true)
  expect(readPrompts('context', root)).toEqual(list)
})

test('モジュールごとに別のファイルに書く', () => {
  const root = evo()
  writePrompts('context', [prompt('A', { t1: 1 })], root)
  expect(readPrompts('completion', root)).toEqual([])
})
