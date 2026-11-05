// 段階4b: 経済のループによるオンライン RSI。worker がエージェントの記憶（方針の文章）を変えるアイデアを出し、
// 投資家が資本に応じて試す番を配る。アイデアは記憶を付けた計測と付けない計測の比較で採点し、LLM では採点しない。
// アイデアが変えるのは記憶だけで、コードは変えない（コードの変更はオフライン RSI だけが行う）
import { compare } from './evolve'
import { type Measure, measure, summary } from './measure'
import type { Complete } from './model'

// 改善の対象ごとの worker。設計書の段階4bの「指示文・実行方針・技能」にあたる
export const WORKERS = {
  instruction: '課題文の読み方と、解き始める前に確かめること',
  policy: '作業の進め方、確かめ方、終え方',
  skill: 'よく使うコマンドやコードの書き方などの技能',
} as const
export type Worker = keyof typeof WORKERS

// ponytail: 経済の定数は仮の値。期を回して偏りが出たら調整する
const INITIAL_CAPITAL = 1
const MIN_CAPITAL = 0.1
// 不採用のときに worker の資本から引く額
const LOSS = 0.2
// 記憶ごとに検証用課題を測る回数
const REPEATS = 5
// 成功率を下げずに、平均費用をこの割合以下にしたアイデアも採用する
const COST_RATIO = 0.8
const IDEA_LIMIT = 300
// worker に見せる、これまでのアイデアの数
const HISTORY_LIMIT = 20

// アイデアを採用するか。成功率が確かに上がったか、成功率を下げずに費用が下がったら採用する
export function judge(
  base: number[],
  candidate: number[],
  tasks: number,
  baseCost: number,
  cost: number,
) {
  const { delta, margin } = compare(base, candidate, tasks)
  const adopted =
    delta > margin || (delta >= 0 && cost <= baseCost * COST_RATIO)
  return { delta, margin, adopted }
}

// 採用されたら、増えた正解数に応じて資本を足す。不採用なら資本を引く
export const settle = (capital: number, adopted: boolean, solved: number) =>
  adopted
    ? capital + 1 + Math.max(0, solved)
    : Math.max(MIN_CAPITAL, capital - LOSS)

export function openIdeas(m: Measure) {
  m.db.run(`CREATE TABLE IF NOT EXISTS workers (
    name TEXT PRIMARY KEY,
    capital REAL NOT NULL
  )`)
  m.db.run(`CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY,
    worker TEXT NOT NULL,
    text TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    base_rate REAL NOT NULL,
    rate REAL NOT NULL,
    margin REAL NOT NULL,
    base_cost REAL NOT NULL,
    cost REAL NOT NULL,
    adopted INTEGER NOT NULL,
    at INTEGER NOT NULL
  )`)
  for (const name of Object.keys(WORKERS)) {
    m.db.run('INSERT OR IGNORE INTO workers (name, capital) VALUES (?, ?)', [
      name,
      INITIAL_CAPITAL,
    ])
  }
  const workers = () =>
    m.db
      .query<{ name: Worker; capital: number }, []>(
        'SELECT name, capital FROM workers ORDER BY name',
      )
      .all()
  return {
    workers,
    // 採用されたアイデアを順に並べたものが記憶
    memory: () =>
      m.db
        .query<{ text: string }, []>(
          'SELECT text FROM ideas WHERE adopted = 1 ORDER BY id',
        )
        .all()
        .map((r) => `- ${r.text}`)
        .join('\n'),
    // 投資家は、資本に比例した確率で試す番を配る
    pick(random = Math.random()): Worker {
      const all = workers()
      let r = random * all.reduce((a, w) => a + w.capital, 0)
      for (const w of all) {
        r -= w.capital
        if (r < 0) return w.name
      }
      return all[all.length - 1].name
    },
    record(
      worker: Worker,
      text: string,
      commit: string,
      base: { rate: number; cost: number },
      candidate: { rate: number; cost: number },
      margin: number,
      adopted: boolean,
      solved: number,
    ) {
      m.db.run(
        'INSERT INTO ideas (worker, text, commit_id, base_rate, rate, margin, base_cost, cost, adopted, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          worker,
          text,
          commit,
          base.rate,
          candidate.rate,
          margin,
          base.cost,
          candidate.cost,
          Number(adopted),
          Date.now(),
        ],
      )
      const capital =
        workers().find((w) => w.name === worker)?.capital ?? INITIAL_CAPITAL
      m.db.run('UPDATE workers SET capital = ? WHERE name = ?', [
        settle(capital, adopted, solved),
        worker,
      ])
    },
  }
}

// その記憶で測った検証用の計測。足りなければ REPEATS 回まで測る
async function measured(
  m: Measure,
  commit: string,
  memory: string,
  complete: Complete,
) {
  const rows = () =>
    m.db
      .query<{ r: number; cost: number }, [string, string, string]>(
        "SELECT CAST(ok AS REAL) / total AS r, cost FROM measurements WHERE commit_id = ? AND split = 'val' AND conditions = ? AND memory = ? AND total IS NOT NULL ORDER BY id",
      )
      .all(commit, m.conditions('val'), memory)
  // 足りない回数を並べて測る。同時に動く試行の数は measure の側の上限に任せる
  await Promise.all(
    Array.from({ length: Math.max(0, REPEATS - rows().length) }, () =>
      measure(m, commit, 'val', complete, memory),
    ),
  )
  const all = rows()
  return {
    rates: all.map((x) => x.r),
    cost: summary(all.map((x) => x.cost)).mean,
  }
}

// これまでに試したアイデアとその結果。worker が同じ方向の案を繰り返さないよう、根拠として共有する
export const history = (m: Measure) =>
  m.db
    .query<
      {
        worker: string
        text: string
        base_rate: number
        rate: number
        base_cost: number
        cost: number
        adopted: number
      },
      [number]
    >('SELECT * FROM ideas ORDER BY id DESC LIMIT ?')
    .all(HISTORY_LIMIT)
    .reverse()
    .map(
      (r) =>
        `- [${r.adopted ? '採用' : '不採用'}] ${r.text}（成功率 ${r.base_rate.toFixed(3)} → ${r.rate.toFixed(3)}、平均費用 $${r.base_cost.toFixed(4)} → $${r.cost.toFixed(4)}）`,
    )
    .join('\n')

// worker にアイデアを1つ出させる。今の記憶で失敗した課題の応答を見せる
async function propose(
  m: Measure,
  worker: Worker,
  commit: string,
  memory: string,
  generator: Complete,
) {
  const failed = m.db
    .query<{ statement: string; reply: string | null }, [string, string]>(
      `SELECT t.statement, (SELECT reply FROM calls WHERE run_id = r.id ORDER BY id DESC LIMIT 1) AS reply
        FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.ok = 0 AND t.split = 'val' AND r.measurement_id =
          (SELECT MAX(id) FROM measurements WHERE commit_id = ? AND split = 'val' AND memory = ?)`,
    )
    .all(commit, memory)
    .slice(0, 4)
    .map(
      (r) =>
        `課題文: ${r.statement.slice(0, 600)}\n最後の応答: ${(r.reply ?? '').slice(-1500)}`,
    )
  const reply = await generator({
    systemPrompt:
      'あなたは、課題を解くエージェントの方針を改善する役です。エージェントは課題文の前に置かれた方針を読んでから課題を解きます。',
    messages: [
      {
        role: 'user',
        content: `担当: ${WORKERS[worker]}

今の方針:
${memory || '（なし）'}

今の方針で失敗した例:
${failed.join('\n---\n') || '（なし）'}

これまでに試したアイデアと結果（成功率と平均費用の変化）:
${history(m) || '（なし）'}

これまでに不採用だったアイデアと同じ方向の案は避けてください。方針に1行で加える改善案を1つだけ、${IDEA_LIMIT}文字以内の日本語で答えてください。担当の範囲に限り、特定の課題の答えは書かないでください。改善案の文だけを答えてください。`,
        timestamp: Date.now(),
      },
    ],
  })
  const text = reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-・\s]+/, '')
    .trim()
    .slice(0, IDEA_LIMIT)
  if (!text) throw new Error('worker がアイデアを返しませんでした')
  return text
}

// 1期。投資家が選んだ worker のアイデアを、稼働版で記憶を付けて測り、今の記憶と比べる
export async function round(m: Measure, solver: Complete, generator: Complete) {
  const commit = m.meta('stable') ?? m.meta('base')
  if (!commit) throw new Error('稼働版も基準版もありません')
  const ideas = openIdeas(m)
  const memory = ideas.memory()
  const worker = ideas.pick()
  const base = await measured(m, commit, memory, solver)
  const text = await propose(m, worker, commit, memory, generator)
  console.log(`${worker}: ${text}`)
  const next = memory ? `${memory}\n- ${text}` : `- ${text}`
  const candidate = await measured(m, commit, next, solver)
  const tasks = m.tasks('val').length
  const { delta, margin, adopted } = judge(
    base.rates,
    candidate.rates,
    tasks,
    base.cost,
    candidate.cost,
  )
  const rate = (x: number[]) => summary(x).mean
  ideas.record(
    worker,
    text,
    commit,
    { rate: rate(base.rates), cost: base.cost },
    { rate: rate(candidate.rates), cost: candidate.cost },
    margin,
    adopted,
    Math.round(delta * tasks),
  )
  const result = { adopted, delta, text }
  console.log(
    `${adopted ? '採用' : '不採用'}: 成功率 ${rate(base.rates).toFixed(3)} → ${rate(candidate.rates).toFixed(3)}（基準 ${margin.toFixed(3)}）、平均費用 $${base.cost.toFixed(4)} → $${candidate.cost.toFixed(4)}`,
  )
  return result
}

// 採用されたアイデアを持つ記憶と持たない記憶を、成績用課題で比べる（段階4bの完了条件）
export async function check(m: Measure, solver: Complete, repeats = 3) {
  const commit = m.meta('stable') ?? m.meta('base')
  if (!commit) throw new Error('稼働版も基準版もありません')
  const memory = openIdeas(m).memory()
  if (!memory) throw new Error('採用されたアイデアがありません')
  // 記憶なしと記憶ありの計測をすべて並べて測る
  const results = await Promise.all(
    (
      [
        ['記憶なし', ''],
        ['記憶あり', memory],
      ] as const
    ).map(async ([name, mem]) => {
      const rs = await Promise.all(
        Array.from({ length: repeats }, () =>
          measure(m, commit, 'test', solver, mem),
        ),
      )
      const rates = rs.map((r) => r.ok / r.total)
      const costs = rs.map((r) => r.cost)
      console.log(
        `${name}: 成功率 ${summary(rates).mean.toFixed(3)}、平均費用 $${summary(costs).mean.toFixed(4)}`,
      )
      return { name, rates, cost: summary(costs).mean }
    }),
  )
  const { delta, margin } = compare(
    results[0].rates,
    results[1].rates,
    m.tasks('test').length,
  )
  console.log(`差 ${delta.toFixed(3)}（基準 ${margin.toFixed(3)}）`)
  return results
}
