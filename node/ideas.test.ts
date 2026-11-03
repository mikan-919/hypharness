import { expect, test } from 'bun:test'
import { history, judge, openIdeas, settle } from './ideas'
import { openMeasure, withMemory } from './measure'

test('アイデアは、成功率が確かに上がるか、成功率を下げずに費用が下がったときだけ採用する', () => {
  const base = Array(5).fill(0.5)
  expect(judge(base, Array(5).fill(0.75), 8, 0.01, 0.01).adopted).toBe(true)
  expect(judge(base, Array(5).fill(0.625), 8, 0.01, 0.01).adopted).toBe(false)
  expect(judge(base, Array(5).fill(0.5), 8, 0.01, 0.007).adopted).toBe(true)
  expect(judge(base, Array(5).fill(0.375), 8, 0.01, 0.005).adopted).toBe(false)
})

test('資本は採用で増え、不採用で減り、下限を下回らない', () => {
  expect(settle(1, true, 2)).toBe(4)
  expect(settle(1, false, 0)).toBeCloseTo(0.8)
  expect(settle(0.1, false, 0)).toBe(0.1)
})

test('投資家は資本に比例して試す番を配り、採用されたアイデアだけが記憶になる', () => {
  const m = openMeasure(':memory:')
  const ideas = openIdeas(m)
  // 資本は instruction 1、policy 1、skill 1。乱数の区間で選ばれる worker が決まる
  expect([0.1, 0.5, 0.9].map((r) => ideas.pick(r))).toEqual([
    'instruction',
    'policy',
    'skill',
  ])
  const r = { rate: 0.5, cost: 0.01 }
  ideas.record('policy', 'テストを実行してから終える', 'c', r, r, 0.2, true, 2)
  ideas.record('skill', '使われない案', 'c', r, r, 0.2, false, 0)
  expect(ideas.memory()).toBe('- テストを実行してから終える')
  expect(ideas.workers()).toEqual([
    { name: 'instruction', capital: 1 },
    { name: 'policy', capital: 4 },
    { name: 'skill', capital: 0.8 },
  ])
  expect(ideas.pick(0.3)).toBe('policy')
  expect(withMemory('', '課題')).toBe('課題')
  expect(withMemory('- 方針', '課題')).toContain('- 方針\n\n## 課題\n課題')
})

test('worker には、これまでのアイデアを採否と成功率・費用の変化つきで古い順に見せる', () => {
  const m = openMeasure(':memory:')
  const ideas = openIdeas(m)
  expect(history(m)).toBe('')
  const base = { rate: 0.5, cost: 0.01 }
  ideas.record(
    'skill',
    '案A',
    'c',
    base,
    { rate: 0.4, cost: 0.012 },
    0.2,
    false,
    -1,
  )
  ideas.record(
    'policy',
    '案B',
    'c',
    base,
    { rate: 0.75, cost: 0.01 },
    0.2,
    true,
    2,
  )
  expect(history(m)).toBe(
    '- [不採用] 案A（成功率 0.500 → 0.400、平均費用 $0.0100 → $0.0120）\n- [採用] 案B（成功率 0.500 → 0.750、平均費用 $0.0100 → $0.0100）',
  )
})
