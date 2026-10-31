import { expect, test } from 'bun:test'
import { openEconomy } from './economy'

const setup = () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  return e
}

test('資本に応じて worker を雇い、解雇した worker は次の採用で記憶ごと再利用する', () => {
  const e = setup()
  const [a, b] = e.companies()
  expect(e.staff(a.id)).toEqual(['worker-1', 'worker-2', 'worker-3'])
  e.db.query('UPDATE companies SET capital = 10 WHERE id = ?').run(a.id)
  expect(e.staff(a.id)).toEqual(['worker-1'])
  expect(e.staff(b.id)).toEqual(['worker-2', 'worker-3', 'worker-4'])
})

test('精算で採点から価値と売上を決め、出資額に応じて配当し、人件費を払う', () => {
  const e = setup()
  const [a] = e.companies()
  e.staff(a.id) // 3人
  const cycle = e.nextCycle()
  e.invest('investor-1', a.id, 30)
  e.postIdea('worker-1', { title: 't', body: 'b' }, cycle)
  e.scoreIdea(e.ideas(cycle)[0].id, 8, '良い')
  e.settle(cycle)
  // 売上 24 の半分 12 を配当、残り 12 を資本に。人件費 30
  expect(e.company(a.id)).toMatchObject({
    value: 8,
    capital: 30 + 30 + 12 - 30,
  })
  expect(e.investors()[0].cash).toBe(100 - 30 + 12)
})

test('過半数の投票と相手の同意で合併し、2人以上の投票で分裂する', () => {
  const e = setup()
  const [a, b] = e.companies()
  e.db.query('UPDATE companies SET capital = 200').run()
  e.staff(a.id) // worker-1..5
  e.staff(b.id) // worker-6..10
  const cycle = e.nextCycle()
  for (const w of ['worker-1', 'worker-2', 'worker-3']) {
    e.vote(w, { kind: 'merge', target: b.id })
  }
  e.vote('worker-6', { kind: 'merge', target: a.id })
  e.vote('worker-7', { kind: 'split', philosophy: '小さく作る' })
  e.vote('worker-8', { kind: 'split' })
  e.settle(cycle)

  const companies = e.companies()
  expect(companies.map((c) => c.name)).toEqual(['会社2', '会社2から分裂'])
  expect(e.workersOf(companies[1].id)).toEqual(['worker-7', 'worker-8'])
  expect(companies[1].philosophy).toBe('小さく作る')
  expect(e.workersOf(companies[0].id)).toHaveLength(8)
})

test('資本が尽きた会社は解散し、不正な操作は拒否する', () => {
  const e = setup()
  const [a] = e.companies()
  e.staff(a.id)
  e.settle(e.nextCycle()) // 成果なし、人件費 30 で資本 0
  expect(e.company(a.id)).toBeNull()
  expect(e.workerCompany('worker-1')).toBeNull()
  expect(() => e.invest('investor-1', 999, 10)).toThrow()
  expect(() => e.invest('investor-1', e.companies()[0].id, 1000)).toThrow()
  expect(() => e.scoreIdea(1, 11, '')).toThrow()
  expect(() => e.propose('worker-1', 'nobody', 'x')).toThrow()
})
