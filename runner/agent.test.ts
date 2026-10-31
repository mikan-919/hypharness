import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ftsQuery, openAgent } from './agent'

test('ftsQuery は記号を除いた3文字ずつの断片を OR でつなぐ', () => {
  expect(ftsQuery('犬を "飼う"。')).toBe('"犬を飼" OR "を飼う"')
  expect(ftsQuery('犬')).toBe('')
})

test('直近より古い記憶を全文検索で引き、エージェント間で記憶が混ざらない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-'))
  const pochi = openAgent(dir, 'pochi')
  pochi.remember('user', '犬を飼い始めた。名前はポチ')
  for (let i = 0; i < 12; i++) pochi.remember('user', `雑談${i}`)

  const { instructions, messages } = pochi.context('犬の名前は何でしたか')
  expect(instructions).toContain('名前はポチ')
  expect(messages).toHaveLength(11)
  expect(
    openAgent(dir, 'other').context('犬の名前').instructions,
  ).not.toContain('ポチ')
  expect(() => openAgent(dir, '../escape')).toThrow()
})
