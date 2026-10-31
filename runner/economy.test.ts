import { expect, test } from 'bun:test'
import { openEconomy } from './economy'

const setup = () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  return e
}

test('目的を設定すると会社が worker を雇い、解雇した worker は次の採用で記憶ごと再利用する', () => {
  const e = setup()
  const [a, b] = e.companies()
  expect(e.workersOf(a.id)).toEqual(['worker-1', 'worker-2', 'worker-3'])
  e.db.query('UPDATE companies SET capital = 10 WHERE id = ?').run(a.id)
  expect(e.staff(a.id)).toEqual(['worker-1'])
  e.db.query('UPDATE companies SET capital = 50 WHERE id = ?').run(b.id)
  expect(e.staff(b.id)).toEqual([
    'worker-2',
    'worker-3',
    'worker-4',
    'worker-5',
    'worker-6',
  ])
})

test('仕事は会社のタスクプールに置き、自社の worker だけが1件ずつ引き受ける', () => {
  const e = setup()
  const [a] = e.companies()
  e.addTask(a.id, '案を出す')
  e.addTask(a.id, '調べる')
  const [first, second] = e.pool(a.id)
  expect(() => e.claimTask('worker-4', first.id)).toThrow()
  e.claimTask('worker-1', first.id)
  expect(() => e.claimTask('worker-1', second.id)).toThrow()
  expect(() => e.claimTask('worker-2', first.id)).toThrow()
  expect(e.pool(a.id).map((t) => t.id)).toEqual([second.id])
  e.finishTask('worker-1', '終えた')
  expect(e.openTask('worker-1')).toBeNull()

  // 解雇された worker の仕事はプールに戻る
  e.claimTask('worker-3', second.id)
  e.db.query('UPDATE companies SET capital = 40 WHERE id = ?').run(a.id)
  e.settle() // 人件費 30 で資本 10 → 1人に減る
  expect(e.workersOf(a.id)).toEqual(['worker-1'])
  expect(e.pool(a.id).map((t) => t.id)).toEqual([second.id])
})

test('精算で未精算の採点から価値と売上を決め、配当と人件費を払い、期を進める', () => {
  const e = setup()
  const [a] = e.companies()
  e.invest('investor-1', a.id, 30)
  e.postIdea('worker-1', { title: 't', body: 'b' })
  e.scoreIdea(e.unscoredIdeas()[0].id, 8, '良い')
  e.settle()
  // 売上 24 の半分 12 を配当、残り 12 を資本に。人件費 30
  expect(e.company(a.id)).toMatchObject({
    value: 8,
    capital: 30 + 30 + 12 - 30,
  })
  expect(e.investors()[0].cash).toBe(100 - 30 + 12)
  expect(e.cycle()).toBe(2)
  // 精算に使った採点は次の期に数えない（成果のない期として価値が半分になる）
  e.db.query('UPDATE companies SET capital = 200 WHERE id = ?').run(a.id)
  e.settle()
  expect(e.company(a.id)?.value).toBe(4)
})

test('過半数の投票と相手の同意で合併し、2人以上の投票で分裂する', () => {
  const e = setup()
  const [a, b] = e.companies()
  e.db.query('UPDATE companies SET capital = 200').run()
  e.staff(a.id) // worker-1..3, 7, 8
  e.staff(b.id) // worker-4..6, 9, 10
  e.addTask(a.id, 'a の仕事')
  for (const w of ['worker-1', 'worker-2', 'worker-3']) {
    e.vote(w, { kind: 'merge', target: b.id })
  }
  e.vote('worker-4', { kind: 'merge', target: a.id })
  e.vote('worker-5', { kind: 'split', philosophy: '小さく作る' })
  e.vote('worker-6', { kind: 'split' })
  e.settle()

  const companies = e.companies()
  expect(companies.map((c) => c.name)).toEqual(['会社2', '会社2から分裂'])
  // 分裂した会社は、合併で上限を超えて解雇された worker を資本の分だけ雇い直す
  expect(e.workersOf(companies[1].id)).toEqual(
    expect.arrayContaining(['worker-5', 'worker-6']),
  )
  expect(companies[1].philosophy).toBe('小さく作る')
  expect(e.workersOf(companies[0].id).length).toBeLessThanOrEqual(5)
  expect(e.pool(companies[0].id).map((t) => t.body)).toEqual(['a の仕事'])
})

test('メッセージは同僚全員に送れて、未読と既読を区別する', () => {
  const e = setup()
  e.sendMessage('worker-1', 'all', '相談したい')
  expect(e.unread('worker-2').map((m) => m.content)).toEqual(['相談したい'])
  expect(e.unread('worker-1')).toEqual([])
  expect(e.unread('worker-4')).toEqual([])
  e.markRead(e.unread('worker-2').map((m) => m.id))
  expect(e.unread('worker-2')).toEqual([])
  expect(() => e.sendMessage('worker-1', 'nobody', 'x')).toThrow()
})

test('資本が尽きた会社は解散し、不正な操作は拒否する', () => {
  const e = setup()
  const [a] = e.companies()
  e.settle() // 成果なし、人件費 30 で資本 0
  expect(e.company(a.id)).toBeNull()
  expect(e.workerCompany('worker-1')).toBeNull()
  expect(() => e.invest('investor-1', 999, 10)).toThrow()
  expect(() => e.scoreIdea(1, 11, '')).toThrow()
  expect(() => e.propose('worker-1', 'nobody', 'x')).toThrow()
})
