// オフライン RSI の最小ループ（固定部）。親候補を選び、親自身に agent/ を直させ、門番を通った変更だけを測り、
// 基準版を上回った候補を新しい基準版にする
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUDGET_MARGIN,
  checkout,
  DIR,
  type Measure,
  measure,
  REPO,
  runAgent,
  summary,
} from './measure'
import type { Budget, Complete } from './model'
import { sandbox } from './sandbox'
import type { Split } from './tasks'

const GATE_TIMEOUT_MS = 5 * 60_000
// ponytail: 改善役の予算は、1課題の予算の10倍。改善役は課題よりも長く読み書きするため。採用の記録が貯まったら見直す
const IMPROVE_BUDGET = 10
// 改善役に渡す1課題分の実行記録の上限
const TRANSCRIPT_LIMIT = 20_000
// ponytail: explore での1候補の変更行数（追加と削除の合計）の上限。RRSI の変更量の制限を固定の値で行う。徐々に絞る方式は記録が貯まってから
const MAX_CHANGED_LINES = 120

// simple は段階1の方式。explore は段階2bの方式で、弱点の抽出・改善対象の選択・変更量の上限を加える
export type Policy = 'simple' | 'explore'
// 改善対象。指示文は GEPA、1つの機能は ModularRSI、コード全体は SICA/DGM にあたる
export const ARMS = {
  prompt:
    '変えてよいのは、モデルに渡す文章（INSTRUCTIONS やツールの説明）だけです。コードの動きは変えないでください',
  module:
    '変えてよいのは、ツール1つか関数1つだけです。ほかの部分は変えないでください',
  code: '制御の流れを含め、/work/agent のどこを変えてもかまいません',
} as const
export type Arm = keyof typeof ARMS
export type ArmStats = { arm: Arm; n: number; wins: number }

// UCB1 で改善対象を選ぶ。試していない対象を先に選び、その後は勝率に試行回数の少なさの分を足した値が最大の対象を選ぶ
export function ucb(stats: ArmStats[]): Arm {
  const arms = Object.keys(ARMS) as Arm[]
  const untried = arms.find((a) => !stats.some((s) => s.arm === a && s.n > 0))
  if (untried) return untried
  const total = stats.reduce((a, s) => a + s.n, 0)
  const score = (s: ArmStats) =>
    s.wins / s.n + Math.sqrt((2 * Math.log(total)) / s.n)
  return stats.reduce((best, s) => (score(s) > score(best) ? s : best)).arm
}

type Status = 'base' | 'adopted' | 'measured' | 'rejected'
export type Candidate = {
  commit_id: string
  parent: string | null
  description: string
  status: Status
  reason: string | null
}

export function openLineage(m: Measure) {
  m.db.run(`CREATE TABLE IF NOT EXISTS candidates (
    commit_id TEXT PRIMARY KEY,
    parent TEXT,
    description TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL
  )`)
  // 段階2bで足した列。前のセッションの表にもなければ足す
  const columns = new Set(
    m.db
      .query<{ name: string }, []>('PRAGMA table_info(candidates)')
      .all()
      .map((c) => c.name),
  )
  if (!columns.has('arm'))
    m.db.run('ALTER TABLE candidates ADD COLUMN arm TEXT')
  if (!columns.has('reward')) {
    m.db.run('ALTER TABLE candidates ADD COLUMN reward INTEGER')
  }
  return {
    setArm: (commit: string, arm: Arm, reward: number) =>
      m.db.run(
        'UPDATE candidates SET arm = ?, reward = ? WHERE commit_id = ?',
        [arm, reward, commit],
      ),
    armStats: () =>
      m.db
        .query<ArmStats, []>(
          'SELECT arm, COUNT(*) AS n, SUM(reward) AS wins FROM candidates WHERE arm IS NOT NULL GROUP BY arm',
        )
        .all(),
    add: (c: Candidate) =>
      m.db.run(
        'INSERT INTO candidates (commit_id, parent, description, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [c.commit_id, c.parent, c.description, c.status, c.reason, Date.now()],
      ),
    set: (commit: string, status: Status, reason: string | null) =>
      m.db.run(
        'UPDATE candidates SET status = ?, reason = ? WHERE commit_id = ?',
        [status, reason, commit],
      ),
    // 親の候補になれるのは、門番を通って測った候補
    pool: () =>
      m.db
        .query<Candidate, []>(
          "SELECT * FROM candidates WHERE status != 'rejected' ORDER BY created_at",
        )
        .all(),
    all: () =>
      m.db
        .query<Candidate, []>('SELECT * FROM candidates ORDER BY created_at')
        .all(),
  }
}

// 現在の課題の数で測った、そのコミットの最新の成功率。課題が増えた後の古い計測は使わない
export function rate(m: Measure, commit: string, split: Split) {
  const row = m.db
    .query<{ ok: number; total: number }, [string, string, number]>(
      'SELECT ok, total FROM measurements WHERE commit_id = ? AND split = ? AND total = ? ORDER BY id DESC LIMIT 1',
    )
    .get(commit, split, m.tasks(split).length)
  return row ? row.ok / row.total : null
}

// 基準版を繰り返し測ったときの成功率のばらつき。2回以上測っていなければ 0
const noise = (m: Measure, commit: string) =>
  summary(
    m.db
      .query<{ r: number }, [string, number]>(
        "SELECT CAST(ok AS REAL) / total AS r FROM measurements WHERE commit_id = ? AND split = 'val' AND total = ?",
      )
      .all(commit, m.tasks('val').length)
      .map((x) => x.r),
  ).std

// 改善後の agent/ を親のツリーに重ねてコミットする。一時的なインデックスを使い、利用者の作業ツリーとブランチには触れない。
// agent/ の複製だけを重ねるため、作業用ディレクトリの agent/ の外に置かれたファイルはコミットに入らない
export async function commitAgent(
  repo: string,
  parent: string,
  agent: string,
  message: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'hyph-commit-'))
  try {
    await Bun.$`cp -a ${agent} ${join(root, 'agent')}`.quiet()
    const env = { ...process.env, GIT_INDEX_FILE: join(root, 'index') }
    const git = (args: string[]) =>
      Bun.$`git -C ${repo} ${args}`.env(env).quiet().text()
    await git(['read-tree', parent])
    await git([`--work-tree=${root}`, 'add', '-A', '--', 'agent'])
    const tree = (await git(['write-tree'])).trim()
    const parentTree = (await git(['rev-parse', `${parent}^{tree}`])).trim()
    if (tree === parentTree) return null
    const commit = (
      await git(['commit-tree', tree, '-p', parent, '-m', message])
    ).trim()
    // 系統の候補が git gc で消えないよう、ブランチとは別の参照に置く
    await git(['update-ref', `refs/hypharness/${commit}`, commit])
    return commit
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// 門番。通れば null、通らなければ理由を返す。候補のコードはホストで実行せず、型検査とテストも隔離環境で行う
export async function gate(
  repo: string,
  parent: string,
  commit: string,
  selfEdit: (agent: string) => Promise<boolean>,
  maxLines = Number.POSITIVE_INFINITY,
  modules = join(REPO, 'node_modules'),
) {
  const changed = (
    await Bun.$`git -C ${repo} diff --name-only ${parent} ${commit}`.text()
  )
    .split('\n')
    .filter(Boolean)
  const outside = changed.filter((p) => !p.startsWith('agent/'))
  if (outside.length)
    return `進化対象の外を変更しています: ${outside.join(', ')}`
  const lines = (
    await Bun.$`git -C ${repo} diff --numstat ${parent} ${commit}`.text()
  )
    .split('\n')
    .filter(Boolean)
    .reduce((n, l) => {
      const [added, removed] = l.split('\t')
      return n + (Number(added) || 0) + (Number(removed) || 0)
    }, 0)
  if (lines > maxLines) {
    return `変更が ${lines} 行で、上限の ${maxLines} 行を超えています`
  }

  const dir = await mkdtemp(join(tmpdir(), 'hyph-gate-'))
  try {
    await Bun.$`git -C ${repo} archive ${commit} | tar -x -C ${dir}`.quiet()
    const check = async (command: string) => {
      const child = Bun.spawn(
        sandbox(dir, `exec 2>&1\n${command}`, [
          [modules, '/work/node_modules'],
        ]),
        { stdout: 'pipe', stderr: 'inherit', timeout: GATE_TIMEOUT_MS },
      )
      const [output, code] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ])
      return code === 0 ? null : output.slice(-2000)
    }
    const types = await check('./node_modules/.bin/tsrs -p node')
    if (types) return `型検査に失敗しました:\n${types}`
    const tests = await check(
      'if [ -n "$(find agent -name \'*.test.ts\')" ]; then bun test agent; fi',
    )
    if (tests) return `agent/ のテストに失敗しました:\n${tests}`
    if (!(await selfEdit(join(dir, 'agent')))) {
      return '改善役として agent/ を変更できませんでした'
    }
    return null
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 自己編集の能力確認。候補を改善役として動かし、決められた小さな変更を agent/ に加えられるかを見る
export async function selfEdit(
  agent: string,
  complete: Complete,
  budget: Budget,
) {
  const work = await mkdtemp(join(tmpdir(), 'hyph-self-'))
  try {
    await Bun.$`cp -a ${agent} ${join(work, 'agent')}`.quiet()
    await runAgent(
      agent,
      work,
      'agent/ の中に NOTE.md というファイルを作り、内容を ok の1行にしてください。それ以外は変更しないでください。',
      complete,
      budget,
      () => {},
      join(DIR, 'logs', 'self-edit.log'),
    )
    return (
      (await Bun.file(join(work, 'agent/NOTE.md'))
        .text()
        .catch(() => '')
        .then((t) => t.trim())) === 'ok'
    )
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// 親の検証用課題での実行記録を作業用ディレクトリに置き、親自身に agent/ を直させる
async function improve(
  m: Measure,
  parent: string,
  complete: Complete,
  budget: Budget,
  focus: string,
) {
  const work = await mkdtemp(join(tmpdir(), 'hyph-improve-'))
  try {
    const agent = await checkout(parent)
    await Bun.$`cp -a ${agent} ${join(work, 'agent')}`.quiet()
    const runs = m.db
      .query<
        { task_id: number; ok: number; cost: number; run: number },
        [string]
      >(
        `SELECT r.task_id, r.ok, r.cost, r.id AS run FROM runs r
          WHERE r.measurement_id = (SELECT MAX(id) FROM measurements WHERE commit_id = ? AND split = 'val')`,
      )
      .all(parent)
    const statements = new Map(
      m.tasks('val').map((t) => [t.id, t.statement] as const),
    )
    for (const r of runs) {
      const last = m.db
        .query<{ context: string; reply: string }, [number]>(
          'SELECT context, reply FROM calls WHERE run_id = ? ORDER BY id DESC LIMIT 1',
        )
        .get(r.run)
      const transcript = last
        ? `${last.context}\n${last.reply}`.slice(-TRANSCRIPT_LIMIT)
        : '（モデルの呼び出しなし）'
      await Bun.write(
        join(work, 'runs', `${r.task_id}.md`),
        `# 課題 ${r.task_id}: ${r.ok ? '成功' : '失敗'}、費用 $${r.cost}\n\n## 課題文\n${statements.get(r.task_id)}\n\n## 実行記録（末尾）\n${transcript}\n`,
      )
    }
    await runAgent(
      agent,
      work,
      `/work/agent は、あなた自身のコード（課題を解くエージェント）の複製です。このエージェントは隔離環境で bun /agent/solve.ts として動き、/task.md の課題文を読み、/work で作業し、モデルは Unix ソケット /model.sock の中継を通して呼びます。依存パッケージはなく、型以外は import できません。
/work/runs に、検証用課題での実行記録があります。記録から失敗の原因や無駄な費用を見つけ、成功率を上げるか、成功率を保ったまま費用を下げるように /work/agent を変更してください。
- 変更は /work/agent の中だけにしてください。それ以外は採用されません
- /task.md・/work・/model.sock を使う動き方は変えないでください
- 最後に、変更内容を1〜3行で /work/CHANGE.md に書いてください${focus && `\n${focus}`}`,
      complete,
      budget,
      () => {},
      join(DIR, 'logs', `improve-${parent.slice(0, 7)}-${Date.now()}.log`),
    )
    const description =
      (
        await Bun.file(join(work, 'CHANGE.md'))
          .text()
          .catch(() => '')
      ).trim() || 'agent/ の変更'
    const commit = await commitAgent(
      REPO,
      parent,
      join(work, 'agent'),
      description.slice(0, 2000),
    )
    return { commit, description }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// 弱点の抽出（Self-Harness、ModularRSI の対比分析）。親の検証用課題での成功と失敗の応答を並べ、
// 失敗に共通する原因を生成役のモデル（固定部）にまとめさせる
async function weakness(m: Measure, parent: string, generator: Complete) {
  const rows = m.db
    .query<{ ok: number; statement: string; reply: string }, [string]>(
      `SELECT r.ok, t.statement, (SELECT reply FROM calls WHERE run_id = r.id ORDER BY id DESC LIMIT 1) AS reply
        FROM runs r JOIN tasks t ON t.id = r.task_id
        WHERE r.measurement_id IN (SELECT id FROM measurements WHERE commit_id = ? AND split = 'val')
          AND t.split = 'val'`,
    )
    .all(parent)
  const failed = rows.filter((r) => !r.ok)
  if (!failed.length)
    return '検証用課題での失敗はありません。費用を下げる変更を考えてください。'
  const show = (r: (typeof rows)[number]) =>
    `課題文: ${r.statement.slice(0, 500)}\n最後の応答: ${(r.reply ?? '').slice(-3000)}`
  const reply = await generator({
    systemPrompt:
      'あなたは AI エージェントの実行記録を分析する役です。日本語で簡潔に答えてください。',
    messages: [
      {
        role: 'user',
        content: `エージェントが成功した例と失敗した例です。両者を比べ、失敗に共通する原因を3つまで、根拠とともに箇条書きにしてください。エージェントのコードをどう変えるべきかの案も1行ずつ付けてください。

## 成功した例
${
  rows
    .filter((r) => r.ok)
    .slice(0, 3)
    .map(show)
    .join('\n---\n') || 'なし'
}

## 失敗した例
${failed.slice(0, 5).map(show).join('\n---\n')}`,
        timestamp: Date.now(),
      },
    ],
  })
  return reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

// 成功率が高い候補ほど選ばれやすくし、低い候補にも機会を残す
function choose(m: Measure, pool: Candidate[]) {
  const weights = pool.map((c) => (rate(m, c.commit_id, 'val') ?? 0) + 0.1)
  let r = Math.random() * weights.reduce((a, b) => a + b, 0)
  for (const [i, c] of pool.entries()) {
    r -= weights[i]
    if (r < 0) return c
  }
  return pool[0]
}

const ensure = async (
  m: Measure,
  commit: string,
  split: Split,
  complete: Complete,
) => {
  const known = rate(m, commit, split)
  if (known !== null) return known
  const r = await measure(m, commit, split, complete)
  return r.ok / r.total
}

// 1周。採否は基準版と比べる。親が基準版より低い候補でも、親を上回っただけでは基準版にしない
export async function evolve(
  m: Measure,
  start: string,
  complete: Complete,
  generator: Complete,
  policy: Policy = 'simple',
) {
  const lineage = openLineage(m)
  let base = m.meta('base')
  if (!base) {
    base = start
    m.setMeta('base', base)
    lineage.add({
      commit_id: base,
      parent: null,
      description: '最初の基準版',
      status: 'base',
      reason: null,
    })
  }
  const baseVal = await ensure(m, base, 'val', complete)
  const parent = choose(m, lineage.pool())
  console.log(`親: ${parent.commit_id.slice(0, 7)}（${parent.description}）`)
  const perTask =
    (Number(m.meta('budget:val')) / m.tasks('val').length) * BUDGET_MARGIN
  await ensure(m, parent.commit_id, 'val', complete)

  const arm = policy === 'explore' ? ucb(lineage.armStats()) : null
  const focus = arm
    ? `- 改善対象: ${ARMS[arm]}
- 変更は合計 ${MAX_CHANGED_LINES} 行以内にしてください
- 実行記録を分析した、失敗に共通する原因:
${await weakness(m, parent.commit_id, generator)}`
    : ''
  if (arm) console.log(`改善対象: ${arm}`)
  const { commit, description } = await improve(
    m,
    parent.commit_id,
    complete,
    { limit: perTask * IMPROVE_BUDGET, spent: 0 },
    focus,
  )
  if (!commit) {
    console.log('改善役は agent/ を変更しませんでした')
    return null
  }
  const reject = (reason: string) => {
    if (arm) lineage.setArm(commit, arm, 0)
    lineage.set(commit, 'rejected', reason)
    console.log(`不採用: ${reason}`)
    return { commit, status: 'rejected' as const, reason }
  }
  lineage.add({
    commit_id: commit,
    parent: parent.commit_id,
    description,
    status: 'measured',
    reason: null,
  })
  console.log(`候補: ${commit.slice(0, 7)}（${description}）`)
  const reason = await gate(
    REPO,
    parent.commit_id,
    commit,
    (agent) =>
      selfEdit(agent, complete, { limit: perTask * IMPROVE_BUDGET, spent: 0 }),
    arm ? MAX_CHANGED_LINES : undefined,
  )
  if (reason) return reject(reason)

  const childVal = (await measure(m, commit, 'val', complete)).ok
  const total = m.tasks('val').length
  // UCB1 の報酬は、候補が親を検証用で上回ったか
  if (arm) {
    const parentVal = rate(m, parent.commit_id, 'val') ?? 0
    lineage.setArm(commit, arm, childVal / total > parentVal ? 1 : 0)
  }
  const delta = childVal / total - baseVal
  // ponytail: ばらつきの2倍を超えた差だけを本物とみなす。課題が少ないうちは検定を使わない
  if (delta <= 2 * noise(m, base)) {
    lineage.set(commit, 'measured', `検証用で基準版との差 ${delta.toFixed(3)}`)
    console.log(`保留: 検証用で基準版との差 ${delta.toFixed(3)}`)
    return { commit, status: 'measured' as const, reason: null }
  }
  const baseTest = await ensure(m, base, 'test', complete)
  const childTest = await ensure(m, commit, 'test', complete)
  if (childTest < baseTest) {
    lineage.set(
      commit,
      'measured',
      `成績用で基準版を下回る（${childTest.toFixed(3)} < ${baseTest.toFixed(3)}）`,
    )
    console.log('保留: 成績用で基準版を下回りました')
    return { commit, status: 'measured' as const, reason: null }
  }
  lineage.set(
    commit,
    'adopted',
    `検証用 +${delta.toFixed(3)}、成績用 ${childTest.toFixed(3)}`,
  )
  m.setMeta('base', commit)
  console.log(`採用: ${commit.slice(0, 7)} を基準版にしました`)
  return { commit, status: 'adopted' as const, reason: null }
}
