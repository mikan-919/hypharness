import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES, MODULE_SUMMARY } from './evolve.ts'

const specs = join(import.meta.dir, '..', 'docs', 'specs')

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
