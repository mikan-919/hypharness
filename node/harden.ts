// 進化用課題の敵対的強化（固定部）。基準版の成績と失敗の記録を生成役に渡して新しい課題を作らせ、
// 基準版がときどき解ける課題だけを加え、安定して解く課題を外す
import { join } from 'node:path'
import { attempt, checkout, DIR, type Measure } from './measure'
import type { Complete } from './model'
import {
  type EvalTask,
  generate,
  relevance,
  type Split,
  validate,
} from './tasks'

// 基準版の解けた割合がこの範囲の課題だけを加える。0% の課題は差を測れず、意味のない難問へ寄る原因になる
export const BAND = [0.2, 0.8] as const
// ponytail: 新しい課題は基準版に4回ずつ解かせる。帯の判定が揺れるなら増やす
const SAMPLES = 4
// 基準版がこの回数以上の計測ですべて解いた課題を外す
const STABLE_RUNS = 3
const TRANSCRIPT_LIMIT = 5_000
const FAILURES = 3

export type Rate = { rate: number; n: number }

export const inBand = (rate: number) => rate >= BAND[0] && rate <= BAND[1]

// 外す課題。新しい課題を1つも加えられなかったときは外さず、課題の表が空にならないようにする
export const stable = (rates: Map<number, Rate>, added: number) =>
  added
    ? [...rates]
        .filter(([, r]) => r.n >= STABLE_RUNS && r.rate === 1)
        .map(([id]) => id)
    : []

// 基準版のこれまでの計測での、課題ごとの解けた割合
function baseRates(m: Measure, base: string, split: Split) {
  const rows = m.db
    .query<{ task_id: number; rate: number; n: number }, [string, string]>(
      `SELECT r.task_id, AVG(r.ok) AS rate, COUNT(*) AS n FROM runs r
        JOIN measurements x ON x.id = r.measurement_id
        WHERE x.commit_id = ? AND x.split = ? GROUP BY r.task_id`,
    )
    .all(base, split)
  const ids = new Set(m.tasks(split).map((t) => t.id))
  return new Map(
    rows
      .filter((r) => ids.has(r.task_id))
      .map((r) => [r.task_id, { rate: r.rate, n: r.n }]),
  )
}

// 成績用の課題は、成績用の課題と成績だけから強化する。改善役が見る検証用の情報と混ぜない
function guidance(
  m: Measure,
  base: string,
  split: Split,
  rates: Map<number, Rate>,
) {
  const tasks = m.tasks(split)
  const listed = tasks
    .map(
      (t) =>
        `- 解けた割合 ${rates.get(t.id)?.rate.toFixed(2) ?? '未計測'}: ${t.statement.slice(0, 300)}`,
    )
    .join('\n')
  const failures = m.db
    .query<{ reply: string }, [string, string]>(
      `SELECT c.reply FROM calls c JOIN runs r ON r.id = c.run_id
        JOIN measurements x ON x.id = r.measurement_id
        WHERE x.commit_id = ? AND x.split = ? AND r.ok = 0
        ORDER BY c.id DESC LIMIT ${FAILURES}`,
    )
    .all(base, split)
    .map((f) => f.reply.slice(-TRANSCRIPT_LIMIT))
  return `いまの課題と、評価対象のエージェントが解けた割合:
${listed}
${failures.length ? `\nエージェントが失敗したときの応答（末尾）:\n${failures.join('\n---\n')}\n` : ''}
いまの課題は易しすぎます。同じ最終目的の範囲で、このエージェントが ${BAND[0] * 100}〜${BAND[1] * 100}% の割合で解ける程度に難しい課題を作ってください。
- いまの課題と同じ内容は避けてください
- 判定が厳しすぎる・仕様があいまいといった理由で解けない課題にはしないでください。課題文だけで正解が一意に決まるようにしてください`
}

export async function harden(
  m: Measure,
  split: Split,
  count: number,
  complete: Complete,
) {
  const base = m.meta('base')
  const goal = m.meta('goal')
  if (!base || !goal) {
    throw new Error('先に generate と evolve で課題と基準版を作ってください')
  }
  m.db.run(`CREATE TABLE IF NOT EXISTS hardening (
    id INTEGER PRIMARY KEY,
    split TEXT NOT NULL,
    base TEXT NOT NULL,
    submitted INTEGER NOT NULL,
    valid INTEGER NOT NULL,
    in_band INTEGER NOT NULL,
    before TEXT NOT NULL,
    after TEXT NOT NULL,
    flagged REAL,
    at INTEGER NOT NULL
  )`)
  const before = baseRates(m, base, split)
  const agent = await checkout(base)
  const after = new Map(before)
  let valid = 0
  // 生成役には、選別の理由に加え、基準版の解けた割合も返す。易しすぎた課題を難しくする手がかりにする
  const accept = async (task: EvalTask) => {
    const reason = await validate(task, (t) => relevance(goal, t, complete))
    if (reason) {
      m.reject(task, reason)
      console.log(
        `  除外: ${task.statement.slice(0, 60)}\n    ${reason.split('\n')[0]}`,
      )
      return reason
    }
    valid++
    let ok = 0
    for (let i = 0; i < SAMPLES; i++) {
      const r = await attempt(
        task,
        agent,
        complete,
        { limit: null, spent: 0 },
        () => {},
        join(DIR, 'logs', `harden-${Date.now()}.log`),
      )
      if (r.ok) ok++
    }
    const rate = ok / SAMPLES
    if (!inBand(rate)) {
      const reason = `評価対象のエージェントが ${SAMPLES} 回中 ${ok} 回解きました。${rate > BAND[1] ? '易しすぎます' : '難しすぎるか、課題文だけでは正解が決まりません'}`
      m.reject(task, reason)
      console.log(`  帯の外（${rate}）: ${task.statement.slice(0, 60)}`)
      return reason
    }
    const id = m.addTask(task, split)
    after.set(id, { rate, n: SAMPLES })
    console.log(`  採用（${rate}）: ${task.statement.slice(0, 60)}`)
    return null
  }
  const { submitted, accepted: added } = await generate(
    goal,
    count,
    complete,
    accept,
    guidance(m, base, split, before),
  )
  for (const id of stable(before, added)) {
    m.db.run('UPDATE tasks SET split = ? WHERE id = ?', [
      `retired-${split}`,
      id,
    ])
    after.delete(id)
  }
  // 課題が変わると1回の計測の費用も変わるため、予算の基準を消し、次の計測で作り直す
  if (added) m.db.run('DELETE FROM meta WHERE key = ?', [`budget:${split}`])
  const reviewed = Number(m.meta('reviewed') ?? 0)
  const flagged = reviewed ? Number(m.meta('flagged') ?? 0) / reviewed : null
  const dist = (r: Map<number, Rate>) =>
    JSON.stringify(Object.fromEntries([...r].map(([id, x]) => [id, x.rate])))
  m.db.run(
    'INSERT INTO hardening (split, base, submitted, valid, in_band, before, after, flagged, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      split,
      base,
      submitted,
      valid,
      added,
      dist(before),
      dist(after),
      flagged,
      Date.now(),
    ],
  )
  return { submitted, valid, added, before, after, flagged }
}
