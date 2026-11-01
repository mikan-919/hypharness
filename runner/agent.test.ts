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
import { ftsQuery, openAgent, respond, rewriteSteps } from './agent'
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

test('ループの依頼は記憶から履歴を送らず、依頼文を記憶に残さない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-'))
  const agent = openAgent(dir, 'market')
  agent.remember('user', '前の会話')
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  let sent = 0
  faux.setResponses([
    (context) => {
      sent = context.messages.filter((m) => m.role !== 'system').length
      return fauxAssistantMessage([fauxText('採点しました')])
    },
  ])
  await respond({
    models,
    model: faux.getModel(),
    agent,
    toolbox: createToolbox(agent.db, new Database(':memory:'), dir),
    message: '長い状況の説明',
    onDelta: () => {},
    loop: true,
  })
  expect(sent).toBe(1)
  expect(
    agent.db.query('SELECT role, content FROM memories ORDER BY id').all(),
  ).toEqual([
    { role: 'user', content: '前の会話' },
    { role: 'assistant', content: '採点しました' },
  ])
})

test('rewrite_context は次の手から step をメモに置き換え、依頼文は残す', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-'))
  const agent = openAgent(dir, 'pochi')
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  let seen: unknown[] = []
  faux.setResponses([
    fauxAssistantMessage(
      [fauxToolCall('file_write', { path: 'a.txt', content: '長い結果' })],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage(
      [
        // 手の途中で切る指定は拒否し、この手を含む範囲は受け付ける
        fauxToolCall('rewrite_context', { from: 1, to: 3, note: 'x' }),
        fauxToolCall('rewrite_context', {
          from: 1,
          to: 2,
          note: 'a.txt に書いた',
        }),
      ],
      { stopReason: 'toolUse' },
    ),
    (context) => {
      seen = context.messages
        .filter((m) => m.role !== 'system')
        .map((m) => m.content)
      return fauxAssistantMessage([fauxText('終えました')])
    },
  ])
  await respond({
    models,
    model: faux.getModel(),
    agent,
    toolbox: createToolbox(agent.db, new Database(':memory:'), dir),
    message: '依頼',
    onDelta: () => {},
    loop: true,
  })
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe('依頼')
  expect(seen[1]).toMatch(
    /^\[step 1〜2 を自分で置き換えたメモ｜.*\]\na\.txt に書いた$/,
  )
})

test('rewriteSteps は手の区切りに合わない範囲を拒否する', () => {
  const steps = [1, 2, 3].map((n) => ({ from: n, to: n, messages: [] }))
  const merged = rewriteSteps(steps, 1, 2, 'メモ')
  expect(merged.map((s) => [s.from, s.to])).toEqual([
    [1, 2],
    [3, 3],
  ])
  expect(() => rewriteSteps(merged, 2, 3, 'メモ')).toThrow(
    '今ある step: 1〜2, 3',
  )
  expect(() => rewriteSteps(merged, 4, 5, 'メモ')).toThrow()
  expect(() => rewriteSteps(merged, 3, 3, ' ')).toThrow()
  expect(rewriteSteps(merged, 1, 3, 'メモ').map((s) => [s.from, s.to])).toEqual(
    [[1, 3]],
  )
})
