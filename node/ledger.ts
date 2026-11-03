// 段階5: 資源配分。モデル呼び出しの費用を区分と期ごとに記録し、期の予算を区分に配分する
import type { Measure } from './measure'
import type { Complete } from './model'

export const KINDS = {
  task: '目的遂行',
  local: '局所改善',
  self: '自己改善',
  verify: '検証',
} as const
export type Kind = keyof typeof KINDS
export type Shares = Record<Kind, number>

// ponytail: 配分の初期値と増減の幅は仮の値。期を重ねて偏りが出たら調整する
const INITIAL: Shares = { task: 0.4, local: 0.15, self: 0.3, verify: 0.15 }
const GROW = 1.25
const SHRINK = 0.8
const MIN_SHARE = 0.05
const MAX_SHARE = 0.5
// 改善量で配分を変える区分。残りの区分は、前の期の比率のまま残りの割合を分ける
const ADAPTIVE: Kind[] = ['self', 'local']
// 画面に送る期の数
const PERIODS = 14

// ponytail: 期は UTC の1日。予算の見直しを週に1回にしたくなったら、期の区切りを変える
export const periodOf = (now = Date.now()) =>
  new Date(now).toISOString().slice(0, 10)

// 前の期に採用があった区分は配分を増やし、なかった区分は減らす
export function nextShares(
  previous: Shares,
  improved: Partial<Record<Kind, boolean>>,
): Shares {
  const next = { ...previous }
  for (const kind of ADAPTIVE) {
    const scaled = previous[kind] * (improved[kind] ? GROW : SHRINK)
    next[kind] = Math.min(MAX_SHARE, Math.max(MIN_SHARE, scaled))
  }
  const others = (Object.keys(INITIAL) as Kind[]).filter(
    (k) => !ADAPTIVE.includes(k),
  )
  const rest = 1 - ADAPTIVE.reduce((a, k) => a + next[k], 0)
  const before = others.reduce((a, k) => a + previous[k], 0)
  for (const kind of others) next[kind] = (previous[kind] / before) * rest
  return next
}

// 呼び出しのたびに費用を知らせる
export const metered =
  (complete: Complete, onCost: (cost: number) => void): Complete =>
  async (context, options) => {
    const reply = await complete(context, options)
    onCost(reply.usage.cost.total)
    return reply
  }

export type LedgerRow = {
  period: string
  kind: Kind
  budget: number | null
  spent: number
  improvement: number
}

export function openLedger(m: Measure) {
  m.db.run(`CREATE TABLE IF NOT EXISTS spend (
    id INTEGER PRIMARY KEY,
    period TEXT NOT NULL,
    kind TEXT NOT NULL,
    cost REAL NOT NULL,
    at INTEGER NOT NULL
  )`)
  m.db.run(`CREATE TABLE IF NOT EXISTS improvements (
    id INTEGER PRIMARY KEY,
    period TEXT NOT NULL,
    kind TEXT NOT NULL,
    value REAL NOT NULL,
    note TEXT NOT NULL,
    at INTEGER NOT NULL
  )`)
  m.db.run(`CREATE TABLE IF NOT EXISTS shares (
    period TEXT PRIMARY KEY,
    task REAL NOT NULL,
    local REAL NOT NULL,
    self REAL NOT NULL,
    verify REAL NOT NULL
  )`)
  const improvement = (period: string, kind: Kind) =>
    m.db
      .query<{ v: number | null }, [string, string]>(
        'SELECT SUM(value) AS v FROM improvements WHERE period = ? AND kind = ?',
      )
      .get(period, kind)?.v ?? 0
  // その期の配分。まだなければ、直前の期の配分と改善量から決めて残す
  const shares = (period: string): Shares => {
    const saved = m.db
      .query<Shares, [string]>(
        'SELECT task, local, self, verify FROM shares WHERE period = ?',
      )
      .get(period)
    if (saved) return saved
    const last = m.db
      .query<Shares & { period: string }, [string]>(
        'SELECT * FROM shares WHERE period < ? ORDER BY period DESC LIMIT 1',
      )
      .get(period)
    const next = last
      ? nextShares(
          {
            task: last.task,
            local: last.local,
            self: last.self,
            verify: last.verify,
          },
          {
            self: improvement(last.period, 'self') > 0,
            local: improvement(last.period, 'local') > 0,
          },
        )
      : INITIAL
    m.db.run(
      'INSERT INTO shares (period, task, local, self, verify) VALUES (?, ?, ?, ?, ?)',
      [period, next.task, next.local, next.self, next.verify],
    )
    return next
  }
  const total = () => {
    const value = m.meta('budget:period')
    return value === null ? null : Number(value)
  }
  const spent = (period: string, kind: Kind) =>
    m.db
      .query<{ c: number | null }, [string, string]>(
        'SELECT SUM(cost) AS c FROM spend WHERE period = ? AND kind = ?',
      )
      .get(period, kind)?.c ?? 0
  const budget = (period: string, kind: Kind) => {
    const t = total()
    return t === null ? null : t * shares(period)[kind]
  }
  return {
    record(kind: Kind, cost: number, now = Date.now()) {
      shares(periodOf(now))
      m.db.run(
        'INSERT INTO spend (period, kind, cost, at) VALUES (?, ?, ?, ?)',
        [periodOf(now), kind, cost, now],
      )
    },
    // 採用で上がった成功率を、その区分の改善量として残す
    improved(kind: Kind, value: number, note: string, now = Date.now()) {
      m.db.run(
        'INSERT INTO improvements (period, kind, value, note, at) VALUES (?, ?, ?, ?, ?)',
        [periodOf(now), kind, value, note, now],
      )
    },
    // 今の期に残っている予算。総予算を決めていなければ上限なし
    remaining(kind: Kind, now = Date.now()) {
      const period = periodOf(now)
      const b = budget(period, kind)
      return b === null ? Number.POSITIVE_INFINITY : b - spent(period, kind)
    },
    rows(now = Date.now()): LedgerRow[] {
      shares(periodOf(now))
      const periods = m.db
        .query<{ period: string }, [number]>(
          'SELECT period FROM shares ORDER BY period DESC LIMIT ?',
        )
        .all(PERIODS)
        .map((r) => r.period)
      return periods.flatMap((period) =>
        (Object.keys(KINDS) as Kind[]).map((kind) => ({
          period,
          kind,
          budget: budget(period, kind),
          spent: spent(period, kind),
          improvement: improvement(period, kind),
        })),
      )
    },
  }
}
