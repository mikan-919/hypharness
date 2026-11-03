import { expect, test } from 'bun:test'
import { metered, nextShares, openLedger } from './ledger'
import { openMeasure } from './measure'

const sum = (s: Record<string, number>) =>
  Object.values(s).reduce((a, b) => a + b, 0)

test('採用があった区分は配分を増やし、なかった区分は減らし、全体は1のまま', () => {
  const start = { task: 0.4, local: 0.15, self: 0.3, verify: 0.15 }
  const next = nextShares(start, { self: true })
  expect(next.self).toBeCloseTo(0.375)
  expect(next.local).toBeCloseTo(0.12)
  // 目的遂行と検証は、前の比率 0.4 : 0.15 のまま残りを分ける
  expect(next.task / next.verify).toBeCloseTo(0.4 / 0.15)
  expect(sum(next)).toBeCloseTo(1)
  // 上限と下限
  let s = start
  for (let i = 0; i < 20; i++) s = nextShares(s, { self: true })
  expect(s.self).toBe(0.5)
  expect(s.local).toBe(0.05)
  expect(sum(s)).toBeCloseTo(1)
})

test('費用は区分と期ごとに記録し、総予算を決めたら区分の残りを返し、次の期の配分は改善量で決まる', async () => {
  const m = openMeasure(':memory:')
  const ledger = openLedger(m)
  const day1 = Date.parse('2026-11-01T12:00:00Z')
  const day2 = Date.parse('2026-11-02T12:00:00Z')
  // 総予算がなければ上限なし
  expect(ledger.remaining('self', day1)).toBe(Number.POSITIVE_INFINITY)
  m.setMeta('budget:period', '1')
  const charge = metered(
    async () => ({ usage: { cost: { total: 0.1 } } }) as never,
    (cost) => ledger.record('self', cost, day1),
  )
  await charge({ messages: [] })
  await charge({ messages: [] })
  expect(ledger.remaining('self', day1)).toBeCloseTo(0.3 - 0.2)
  ledger.improved('self', 0.15, 'abc', day1)
  const rows = ledger.rows(day2)
  expect(rows.map((r) => r.period)).toContain('2026-11-01')
  const self1 = rows.find((r) => r.period === '2026-11-01' && r.kind === 'self')
  expect(self1).toMatchObject({ budget: 0.3, improvement: 0.15 })
  expect(self1?.spent).toBeCloseTo(0.2)
  // 1日目に自己改善の採用があったので、2日目の自己改善の配分は 0.3 × 1.25
  const self2 = rows.find((r) => r.period === '2026-11-02' && r.kind === 'self')
  expect(self2?.budget).toBeCloseTo(0.375)
  expect(
    rows.find((r) => r.period === '2026-11-02' && r.kind === 'local')?.budget,
  ).toBeCloseTo(0.12)
})
