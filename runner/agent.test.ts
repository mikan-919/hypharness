import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai'
import { ftsQuery, openAgent, respond } from './agent'
import { createToolbox } from './tools'

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

test('respond はツールを実行して結果を返し、最終回答だけを記憶に残す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-'))
  const agent = openAgent(dir, 'pochi')
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxToolCall('file_write', { path: 'a.txt', content: 'メモ' }),
        fauxToolCall('file_read', { path: '../escape' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([fauxText('書きました')]),
  ])
  const deltas: string[] = []
  const text = await respond({
    models,
    model: faux.getModel(),
    agent,
    toolbox: createToolbox(agent.db, new Database(':memory:'), dir),
    message: 'メモして',
    onDelta: (d) => deltas.push(d),
  })

  expect(text).toBe('書きました')
  expect(deltas.join('')).toBe('書きました')
  expect(await Bun.file(join(dir, 'a.txt')).text()).toBe('メモ')
  expect(
    agent.db.query('SELECT role, content FROM memories ORDER BY id').all(),
  ).toEqual([
    { role: 'user', content: 'メモして' },
    { role: 'assistant', content: '書きました' },
  ])
})
