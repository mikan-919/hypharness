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
// 改善対象。指示文は GEPA、1つの機能は ModularRSI、仕様は SpecForge、コード全体は SICA/DGM にあたる
export const ARMS = {
  prompt:
    '変えてよいのは、モデルに渡す文章（INSTRUCTIONS やツールの説明）だけです。コードの動きは変えないでください',
  module:
    '変えてよいのは、ツール1つか関数1つだけです。ほかの部分は変えないでください',
  spec: '先に /work/agent/SPEC.md（各部の責務・依存の順・失敗の扱い）を、実行記録の失敗が起きないように直し、その仕様に合わせてコードを直してください。仕様に書いていない動きは足さないでください',
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

// 今と同じ条件（解答役の設定と課題の組）で測った、そのコミットの成功率の平均。条件が変わる前の計測は使わない
export function rate(m: Measure, commit: string, split: Split) {
  // 繰り返し測った版は平均で比べる。ばらつき（noise）と同じ計測群を使うため
  const row = m.db
    .query<{ r: number | null }, [string, string, string]>(
      "SELECT AVG(CAST(ok AS REAL) / total) AS r FROM measurements WHERE commit_id = ? AND split = ? AND conditions = ? AND memory = '' AND total IS NOT NULL",
    )
    .get(commit, split, m.conditions(split))
  return row?.r ?? null
}

// 今と同じ条件で測った、そのコミットの計測ごとの成功率
const rates = (m: Measure, commit: string, split: Split) =>
  m.db
    .query<{ r: number }, [string, string, string]>(
      "SELECT CAST(ok AS REAL) / total AS r FROM measurements WHERE commit_id = ? AND split = ? AND conditions = ? AND memory = '' AND total IS NOT NULL ORDER BY id",
    )
    .all(commit, split, m.conditions(split))
    .map((x) => x.r)

// 2つの成功率の差の検定。各計測を課題数 tasks 回の試行とみなし、二項分布のばらつきから差のばらつきを求める。
// 返す margin は差のばらつきの2倍で、delta がこれを超えれば偶然ではないとみなす
export function compare(base: number[], candidate: number[], tasks: number) {
  const b = summary(base).mean
  const c = summary(candidate).mean
  const variance =
    (b * (1 - b)) / (tasks * base.length) +
    (c * (1 - c)) / (tasks * candidate.length)
  return { delta: c - b, margin: 2 * Math.sqrt(variance) }
}

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
    // 固定部（中継・ノード・評価器）も参照用に置く。改善役が固定部の変更を提案するときに読む
    await Bun.$`mkdir -p ${join(work, 'fixed')} && git -C ${REPO} archive ${parent} node src package.json | tar -x -C ${join(work, 'fixed')}`.quiet()
    const runs = m.db
      .query<
        { task_id: number; ok: number; cost: number; run: number },
        [string]
      >(
        `SELECT r.task_id, r.ok, r.cost, r.id AS run FROM runs r
          WHERE r.measurement_id = (SELECT MAX(id) FROM measurements WHERE commit_id = ? AND split = 'val' AND memory = '')`,
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
- 最後に、変更内容を1〜3行で /work/CHANGE.md に書いてください
- 失敗の原因が固定部（/work/fixed の中継・ノード・評価器・モデル中継）にあり、agent/ では直せないときは、固定部の変更を /work/fixed からの相対パスの unified diff で /work/META.patch に書いてください。固定部の変更は自動では採用されず、利用者の承認を待ちます${focus && `\n${focus}`}`,
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
    const patch = (
      await Bun.file(join(work, 'META.patch'))
        .text()
        .catch(() => '')
    ).trim()
    if (patch) {
      const id = openProposals(m).add(parent, description, `${patch}\n`)
      console.log(
        `固定部の変更の提案 #${id} を残しました。承認は画面か approve で行います`,
      )
    }
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
        WHERE r.measurement_id IN (SELECT id FROM measurements WHERE commit_id = ? AND split = 'val' AND memory = '')
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
  console.log(`弱点の抽出の費用: $${reply.usage.cost.total.toFixed(4)}`)
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

// 1周。門番を通った候補を測って系統の記録に残す。1回の計測はぶれが大きいため、ここでは基準版を変えない（DGM と同じく記録から親を選ぶ）
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
  // 予算の基準は基準版の最初の計測で決まる
  await ensure(m, base, 'val', complete)
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
  const improveBudget = { limit: perTask * IMPROVE_BUDGET, spent: 0 }
  const editBudget = { limit: perTask * IMPROVE_BUDGET, spent: 0 }
  const { commit, description } = await improve(
    m,
    parent.commit_id,
    complete,
    improveBudget,
    focus,
  )
  console.log(`改善の費用: $${improveBudget.spent.toFixed(4)}`)
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
    (agent) => selfEdit(agent, complete, editBudget),
    arm ? MAX_CHANGED_LINES : undefined,
  )
  console.log(`自己編集の確認の費用: $${editBudget.spent.toFixed(4)}`)
  if (reason) return reject(reason)
  // 批評役（RRSI）に不要な変更を指摘させ、除いた候補が門番を通れば、そちらを測る
  const kept = await filter(
    REPO,
    parent.commit_id,
    commit,
    description,
    generator,
  )
  if (kept) {
    const again = await gate(
      REPO,
      parent.commit_id,
      kept,
      (agent) => selfEdit(agent, complete, editBudget),
      arm ? MAX_CHANGED_LINES : undefined,
    )
    if (again) {
      console.log(
        `不要な変更を除いた候補は門番を通らないため、元の候補を測ります: ${again.split('\n')[0]}`,
      )
    } else {
      lineage.set(
        commit,
        'rejected',
        `不要な変更を除いた候補 ${kept.slice(0, 7)} に置き換えました`,
      )
      lineage.add({
        commit_id: kept,
        parent: parent.commit_id,
        description,
        status: 'measured',
        reason: null,
      })
      console.log(
        `候補: ${kept.slice(0, 7)}（${commit.slice(0, 7)} から不要な変更を除いたもの）`,
      )
      return measureCandidate(m, lineage, parent.commit_id, kept, arm, complete)
    }
  }
  return measureCandidate(m, lineage, parent.commit_id, commit, arm, complete)
}

async function measureCandidate(
  m: Measure,
  lineage: ReturnType<typeof openLineage>,
  parent: string,
  commit: string,
  arm: Arm | null,
  complete: Complete,
) {
  const childVal = (await measure(m, commit, 'val', complete)).ok
  const total = m.tasks('val').length
  // UCB1 の報酬は、候補が親を検証用で上回ったか
  if (arm) {
    const parentVal = rate(m, parent, 'val') ?? 0
    lineage.setArm(commit, arm, childVal / total > parentVal ? 1 : 0)
  }
  lineage.set(commit, 'measured', `検証用 ${childVal}/${total}`)
  console.log(`記録: 検証用 ${childVal}/${total}`)
  return { commit, status: 'measured' as const, reason: null }
}

// 配る版を決める。進化の周回での検証用の成功率で上位 top 件の候補を選び、検証用・成績用を repeats 回ずつ測り直す。
// 候補は進化の周回で測った最初の1回で選び、上振れしているその1回は判定に使わない。2回目以降は前に中断した分も含めて使い、
// 足りない分だけ測る。基準版と、候補の成績用は全計測を使う。
// 検証用で基準版を確かに上回り、成績用で確かに下回らない候補のうち、検証用の差が最大のものを基準版にする
export async function promote(
  m: Measure,
  complete: Complete,
  top = 3,
  repeats = 5,
) {
  const lineage = openLineage(m)
  const base = m.meta('base')
  if (!base) throw new Error('基準版がありません。先に evolve を回してください')
  const candidates = lineage
    .pool()
    .filter((c) => c.status === 'measured')
    .map((c) => ({ c, r: rates(m, c.commit_id, 'val')[0] ?? null }))
    .filter((x): x is { c: Candidate; r: number } => x.r !== null)
    .sort((a, b) => b.r - a.r)
    .slice(0, top)
  console.log(
    `測り直す候補: ${candidates.map(({ c, r }) => `${c.commit_id.slice(0, 7)}（最初の検証用 ${r.toFixed(2)}）`).join('、') || 'なし'}`,
  )
  // 互いに依存しない計測は並べて測る。同時に動く試行の数は measure の側で抑える
  const again = (commit: string, split: Split, n: number) =>
    Promise.all(
      Array.from({ length: n }, () =>
        measure(m, commit, split, complete).then((r) => r.ok / r.total),
      ),
    )
  const pad = async (commit: string, split: Split, skip = 0) => {
    const known = rates(m, commit, split).slice(skip)
    const rest = Math.max(0, repeats - known.length)
    console.log(
      `${commit === base ? '基準版' : '候補'} ${commit.slice(0, 7)} の${split}: 計測済み ${known.length} 回、あと ${rest} 回`,
    )
    return [...known, ...(await again(commit, split, rest))]
  }
  // 候補の成績用は、検証用で基準版を上回ったときだけ測る
  const [baseVal, baseTest, ...vals] = await Promise.all([
    pad(base, 'val'),
    pad(base, 'test'),
    ...candidates.map(({ c }) => pad(c.commit_id, 'val', 1)),
  ])
  const passed = await Promise.all(
    candidates.map(async ({ c }, i) => {
      const id = c.commit_id.slice(0, 7)
      const val = compare(baseVal, vals[i], m.tasks('val').length)
      const line = `検証用 差 ${val.delta.toFixed(3)}（基準 ${val.margin.toFixed(3)}）`
      if (val.delta <= val.margin) {
        console.log(`${id}: 見送り、${line}`)
        return null
      }
      const test = compare(
        baseTest,
        await pad(c.commit_id, 'test'),
        m.tasks('test').length,
      )
      if (-test.delta > test.margin) {
        console.log(
          `${id}: 見送り、${line}、成績用で下回る（差 ${test.delta.toFixed(3)}）`,
        )
        return null
      }
      console.log(`${id}: 合格、${line}、成績用 差 ${test.delta.toFixed(3)}`)
      return { commit: c.commit_id, delta: val.delta }
    }),
  )
  let best: { commit: string; delta: number } | null = null
  for (const p of passed) if (p && (!best || p.delta > best.delta)) best = p
  if (!best) {
    console.log('基準版は変えません')
    return null
  }
  lineage.set(best.commit, 'adopted', `検証用 +${best.delta.toFixed(3)}`)
  m.setMeta('base', best.commit)
  // 配る前に、目的遂行タスクの一部で試す（段階3）
  m.setMeta('canary', best.commit)
  console.log(
    `採用: ${best.commit.slice(0, 7)} を基準版にし、試験版として配りました`,
  )
  return best
}

// 固定部の変更の提案（図の META）。自動では採用せず、利用者が承認したときだけ hypharness への PR にする
type ProposalStatus = 'pending' | 'approved' | 'rejected'
export type Proposal = {
  id: number
  parent: string
  description: string
  patch: string
  status: ProposalStatus
  pr: string | null
}
export function openProposals(m: Measure) {
  m.db.run(`CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY,
    parent TEXT NOT NULL,
    description TEXT NOT NULL,
    patch TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    pr TEXT,
    created_at INTEGER NOT NULL
  )`)
  return {
    add: (parent: string, description: string, patch: string) =>
      Number(
        m.db
          .query(
            'INSERT INTO proposals (parent, description, patch, created_at) VALUES (?, ?, ?, ?)',
          )
          .run(parent, description, patch, Date.now()).lastInsertRowid,
      ),
    get: (id: number) =>
      m.db
        .query<Proposal, [number]>(
          'SELECT id, parent, description, patch, status, pr FROM proposals WHERE id = ?',
        )
        .get(id),
    all: () =>
      m.db
        .query<Proposal, []>(
          'SELECT id, parent, description, patch, status, pr FROM proposals ORDER BY id',
        )
        .all(),
    pending: () =>
      m.db
        .query<Proposal, []>(
          "SELECT id, parent, description, patch, status, pr FROM proposals WHERE status = 'pending' ORDER BY id",
        )
        .all(),
    set: (id: number, status: ProposalStatus, pr: string | null = null) =>
      m.db.run('UPDATE proposals SET status = ?, pr = ? WHERE id = ?', [
        status,
        pr,
        id,
      ]),
  }
}

// 承認した提案を、hypharness の既定のブランチから切ったブランチに当てて PR にする。main には直接入れない
export async function approve(m: Measure, id: number, repo = REPO) {
  const proposals = openProposals(m)
  const p = proposals.get(id)
  if (!p) throw new Error(`提案 #${id} はありません`)
  if (p.status !== 'pending') throw new Error(`提案 #${id} は ${p.status} です`)
  const remote = (
    await Bun.$`git -C ${repo} remote get-url origin`.text()
  ).trim()
  const { repoName } = await import('./pr')
  const name = repoName(remote)
  const base = (
    await Bun.$`gh repo view ${name} --json defaultBranchRef -q .defaultBranchRef.name`.text()
  ).trim()
  const branch = `hyph/meta-${id}`
  const dir = await mkdtemp(join(tmpdir(), 'hyph-meta-'))
  try {
    await Bun.$`git clone -q ${remote} ${dir}`.quiet()
    await Bun.$`git -C ${dir} checkout -q -b ${branch} origin/${base}`.quiet()
    const file = join(dir, '.git', 'meta.patch')
    await Bun.write(file, p.patch)
    // 改善役が a/ b/ の接頭辞を付けずに書いた差分も当てられるようにする
    const applied =
      (await Bun.$`git -C ${dir} apply --index ${file}`.quiet().nothrow())
        .exitCode === 0 ||
      (await Bun.$`git -C ${dir} apply --index -p0 ${file}`.quiet().nothrow())
        .exitCode === 0
    if (!applied)
      throw new Error(`提案 #${id} の差分を ${base} に当てられません`)
    const title = `固定部の変更の提案 #${id}: ${p.description.split('\n')[0].slice(0, 60)}`
    await Bun.$`git -C ${dir} commit -q -m ${title}`.quiet()
    await Bun.$`git -C ${dir} push -q origin ${branch}`.quiet()
    const url = (
      await Bun.$`gh pr create -R ${name} --base ${base} --head ${branch} --title ${title} --body ${`${p.description}\n\n---\nオフライン RSI の改善役が、候補 ${p.parent.slice(0, 7)} の改善の途中で出した固定部の変更の提案です。利用者が承認したため PR にしました。`}`
        .cwd(dir)
        .text()
    ).trim()
    proposals.set(id, 'approved', url)
    return url
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 不要な変更の除去（RRSI の批評）。候補の差分を生成役のモデル（固定部）に見せ、説明した改善に要らないファイルの変更を挙げさせる。
// 挙げられたファイルを親の版に戻した候補をコミットして返す。除くものがなければ null
export async function filter(
  repo: string,
  parent: string,
  commit: string,
  description: string,
  critic: Complete,
) {
  const files = (
    await Bun.$`git -C ${repo} diff --name-only ${parent} ${commit} -- agent`.text()
  )
    .split('\n')
    .filter(Boolean)
  // 1ファイルだけの変更は、除くと何も残らない
  if (files.length < 2) return null
  const patch =
    await Bun.$`git -C ${repo} diff ${parent} ${commit} -- agent`.text()
  const reply = await critic({
    systemPrompt:
      'あなたは AI エージェントのコードの変更を批評する役です。指示された形式だけで答えてください。',
    messages: [
      {
        role: 'user',
        content: `次の変更の説明と差分です。説明した改善に必要のない変更（無関係な整形・使われない追加・説明と関係のない機能）だけを含むファイルを、JSON の文字列の配列で答えてください。すべて必要なら [] と答えてください。

## 説明
${description}

## 差分
${patch.slice(0, 30_000)}`,
        timestamp: Date.now(),
      },
    ],
  })
  const text = reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const listed = (() => {
    try {
      const v = JSON.parse(
        text.slice(text.indexOf('['), text.lastIndexOf(']') + 1),
      )
      return Array.isArray(v) ? v : []
    } catch {
      console.log(
        `批評役の答えを読めないため、除去をしません: ${text.slice(0, 200)}`,
      )
      return []
    }
  })()
  const revert = files.filter((f) => listed.includes(f))
  if (!revert.length || revert.length === files.length) return null
  console.log(`批評役が不要とした変更: ${revert.join(', ')}`)
  const dir = await mkdtemp(join(tmpdir(), 'hyph-filter-'))
  try {
    await Bun.$`git -C ${repo} archive ${commit} agent | tar -x -C ${dir}`.quiet()
    for (const f of revert) {
      const old = await Bun.$`git -C ${repo} show ${parent}:${f}`
        .quiet()
        .nothrow()
      if (old.exitCode === 0) await Bun.write(join(dir, f), old.stdout)
      else await rm(join(dir, f), { force: true })
    }
    return await commitAgent(
      repo,
      parent,
      join(dir, 'agent'),
      `${description}\n\n（批評役が不要とした ${revert.join(', ')} の変更を除いたもの）`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// 中継と画面に送る系統と提案。中継に置くのはコミット・状態・数値と、提案の変えるファイルの名前と行数だけ
export function evolutionSummary(m: Measure) {
  const lineage = openLineage(m)
    .all()
    .slice(-500)
    .map((c) => ({
      commit: c.commit_id,
      parent: c.parent,
      status: c.status,
      val: rate(m, c.commit_id, 'val'),
    }))
  const proposals = openProposals(m)
    .all()
    .slice(-500)
    .map((p) => {
      const lines = p.patch.split('\n')
      return {
        id: p.id,
        parent: p.parent,
        files: [
          ...new Set(
            lines
              .filter((l) => l.startsWith('+++ ') && !l.endsWith('/dev/null'))
              .map((l) => l.slice(4).replace(/^b\//, '').slice(0, 200)),
          ),
        ].slice(0, 50),
        lines: lines.filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l))
          .length,
        status: p.status,
        pr: p.pr,
      }
    })
  return { lineage, proposals }
}
