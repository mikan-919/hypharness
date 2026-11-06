import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MODULES,
  MODULE_SUMMARY,
  paretoPrompts,
  rankPrompts,
  type PromptCandidate,
} from './evolve.ts'

const specs = join(import.meta.dir, '..', 'docs', 'specs')

const prompt = (text: string, passes: Record<string, 0 | 1>, cost = 0): PromptCandidate => ({
  module: 'context',
  text,
  passes,
  cost,
})

test('MODULES の5つの値が docs/specs のファイル名と一致する', () => {
  const names = readdirSync(specs)
    .filter((name) => name.endsWith('.md'))
    .map((name) => name.slice(0, -'.md'.length))
    .sort()
  const values: string[] = [...MODULES]
  expect(values.sort()).toEqual(names)
})

test('MODULES の5つの値は agent-loop・tool-use・observation・context・completion', () => {
  expect(MODULES).toEqual(['agent-loop', 'tool-use', 'observation', 'context', 'completion'])
})

test('モジュールごとに1行の説明がある', () => {
  for (const name of MODULES) {
    expect(MODULE_SUMMARY[name].length).toBeGreaterThan(0)
    expect(MODULE_SUMMARY[name].includes('\n')).toBe(false)
  }
})

test('別々の課題にだけ通る2つの候補は両方残る', () => {
  const a = prompt('A', { t1: 1 })
  const b = prompt('B', { t2: 1 })
  expect(paretoPrompts([a, b]).map((p) => p.text)).toEqual(['A', 'B'])
})

test('全課題で同等以上かつ1つで上回る候補があるとき、下回る候補は残らない', () => {
  const a = prompt('A', { t1: 1, t2: 1 })
  const b = prompt('B', { t1: 1, t2: 0 })
  expect(paretoPrompts([a, b]).map((p) => p.text)).toEqual(['A'])
})

test('同じ text の候補は1つになる', () => {
  const a = prompt('A', { t1: 1 })
  const b = prompt('A', { t2: 1 })
  expect(paretoPrompts([a, b])).toEqual([a])
})

test('rankPrompts は通過数の合計の降順、同じなら cost の昇順に並べる', () => {
  const low = prompt('A', { t1: 1 })
  const high = prompt('B', { t1: 1, t2: 1 })
  const cheap = prompt('C', { t1: 1 }, 1)
  const expensive = prompt('D', { t1: 1 }, 2)
  expect(rankPrompts([low, high, expensive, cheap]).map((p) => p.text)).toEqual(['B', 'A', 'C', 'D'])
})
