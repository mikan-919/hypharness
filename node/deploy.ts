import { compare, openLineage } from './evolve'
import type { Measure } from './measure'

// 試験版で動かすタスクの割合
export const CANARY_SHARE = 0.25
// 判定付きのタスクで、双方がこの数に達するまでは復帰の判断をしない
export const MIN_RESULTS = 3
// 試験版の判定付きのタスクがこの数に達し、下回っていなければ稼働版にする
export const CANARY_TASKS = 10

export type Verdict = 'rollback' | 'promote' | null

// 判定付きのタスクの成否（1か0）から、試験版の扱いを決める。各タスクを1回の試行とみなして差を検定する
export function verdict(stable: number[], canary: number[]): Verdict {
  if (canary.length < MIN_RESULTS || stable.length < MIN_RESULTS) return null
  const { delta, margin } = compare(stable, canary, 1)
  if (-delta > margin) return 'rollback'
  return canary.length >= CANARY_TASKS ? 'promote' : null
}

// セッションの稼働版（stable）と試験版（canary）。稼働版がなければ基準版を使う
export function openDeploy(m: Measure) {
  m.db.run(`CREATE TABLE IF NOT EXISTS deployments (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    version TEXT NOT NULL,
    role TEXT NOT NULL,
    ok INTEGER,
    cost REAL NOT NULL,
    at INTEGER NOT NULL
  )`)
  const stable = () => m.meta('stable') ?? m.meta('base')
  const results = (version: string, role: 'stable' | 'canary') =>
    m.db
      .query<{ ok: number }, [string, string]>(
        'SELECT ok FROM deployments WHERE version = ? AND role = ? AND ok IS NOT NULL ORDER BY id',
      )
      .all(version, role)
      .map((r) => r.ok)
  const cost = (version: string, role: string) =>
    m.db
      .query<{ c: number | null }, [string, string]>(
        'SELECT AVG(cost) AS c FROM deployments WHERE version = ? AND role = ?',
      )
      .get(version, role)?.c ?? 0
  return {
    stable,
    canary: () => m.meta('canary'),
    // ponytail: 試験版に回すかは乱数で決める。タスクの種類に偏りが出たら、種類ごとに割り振る
    pick(random = Math.random()) {
      const version = stable()
      if (!version) throw new Error('稼働版も基準版もありません')
      const canary = m.meta('canary')
      return canary && random < CANARY_SHARE
        ? { version: canary, role: 'canary' as const }
        : { version, role: 'stable' as const }
    },
    record(
      task: number,
      version: string,
      role: 'stable' | 'canary',
      ok: boolean | null,
      spent: number,
    ) {
      m.db.run(
        'INSERT INTO deployments (task_id, version, role, ok, cost, at) VALUES (?, ?, ?, ?, ?, ?)',
        [
          task,
          version,
          role,
          ok === null ? null : Number(ok),
          spent,
          Date.now(),
        ],
      )
    },
    // 試験版の結果が出るたびに呼ぶ。復帰したら試験版を外して候補を不採用にし、基準版も稼働版へ戻す
    decide(): Verdict {
      const canary = m.meta('canary')
      const current = stable()
      if (!canary || !current) return null
      const v = verdict(results(current, 'stable'), results(canary, 'canary'))
      const costs = `平均費用 稼働版 $${cost(current, 'stable').toFixed(4)}、試験版 $${cost(canary, 'canary').toFixed(4)}`
      if (v === 'rollback') {
        m.db.run("DELETE FROM meta WHERE key = 'canary'")
        openLineage(m).set(canary, 'rejected', '試験配備で稼働版を下回った')
        if (m.meta('base') === canary) m.setMeta('base', current)
        console.log(
          `試験版 ${canary.slice(0, 7)} が稼働版を下回ったため、${current.slice(0, 7)} に戻しました（${costs}）`,
        )
      }
      if (v === 'promote') {
        m.setMeta('stable', canary)
        m.db.run("DELETE FROM meta WHERE key = 'canary'")
        console.log(
          `試験版 ${canary.slice(0, 7)} を稼働版にしました（${costs}）`,
        )
      }
      return v
    },
  }
}
