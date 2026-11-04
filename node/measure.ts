// 候補（コミット）の計測（固定部）。課題ごとに、候補の agent/ を隔離環境で動かし、判定コマンドで成否を決める。
// 最終目的はセッションごとに変わるため、課題の表と予算の基準はセッションごとの SQLite に分ける。
// 使い方:
//   bun run measure <セッション> generate <最終目的のファイル> [検証用の数] [成績用の数]
//   bun run measure <セッション> review [件数]
//   bun run measure <セッション> run <コミット> [回数] [val|test]
//   bun run measure <セッション> evolve [周回数] [最初の基準版のコミット] [simple|explore]
//   bun run measure <セッション> promote [候補の数] [測り直す回数]
//   bun run measure <セッション> deploy <コミット>
//   bun run measure <セッション> budget <1期の総予算（ドル）>
//   bun run measure <セッション> ledger
//   bun run measure <セッション> ideas [期数]
//   bun run measure <セッション> ideas-check [回数]
//   bun run measure <セッション> harden [val|test] [生成する数]
//   bun run measure <セッション> flag <課題の番号>
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Credential, CredentialStore } from '@earendil-works/pi-ai'
import { createModels } from '@earendil-works/pi-ai/models'
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai'
import { KINDS, type Kind, metered, openLedger } from './ledger'
import { type Budget, type Complete, serveModel } from './model'
import {
  diff,
  type EvalTask,
  generate,
  judge,
  prepare,
  relevance,
  type Split,
  sandboxFor,
  validate,
  type Workspace,
} from './tasks'
import { unpack } from './vault'

export const DIR = join(homedir(), '.hyph')
const solverModel = () => process.env.MODEL || 'gpt-6.1-sol'
export const REPO = join(import.meta.dir, '..')
// ponytail: 解答役を同時に4つまで動かす。ノードの CPU とモデルの流量制限を見て変える
const CONCURRENCY = 4
const AGENT_TIMEOUT_MS = 10 * 60_000
// ponytail: 1課題の予算は、基準の計測での1課題あたりの費用の2倍。同じ費用で上限を切ると、
// ばらつきで基準版自身が予算切れになり成功率が下がるため、余裕を持たせる。採否の記録が貯まったら見直す
export const BUDGET_MARGIN = 2
// ponytail: 解答役の1回の呼び出しは120秒まで（時間切れは再試行する）。生成役は推論が深く長くかかるため、SDK の既定（10分）のまま
const SOLVER_TIMEOUT_MS = 120_000

type Row = EvalTask & { id: number; split: Split }
type Measurement = { id: number; ok: number; total: number; cost: number }

export function openMeasure(path: string) {
  const db = new Database(path, { strict: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY,
      split TEXT NOT NULL,
      statement TEXT NOT NULL,
      files TEXT NOT NULL,
      check_command TEXT NOT NULL,
      check_files TEXT NOT NULL,
      solution TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      workspace TEXT
    );
    CREATE TABLE IF NOT EXISTS rejected (
      id INTEGER PRIMARY KEY,
      task TEXT NOT NULL,
      reason TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY,
      commit_id TEXT NOT NULL,
      split TEXT NOT NULL,
      budget REAL,
      ok INTEGER,
      total INTEGER,
      cost REAL,
      started_at INTEGER NOT NULL,
      memory TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      measurement_id INTEGER NOT NULL,
      task_id INTEGER NOT NULL,
      ok INTEGER NOT NULL,
      cost REAL NOT NULL,
      exit_code INTEGER,
      patch TEXT
    );
    CREATE TABLE IF NOT EXISTS calls (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL,
      context TEXT NOT NULL,
      reply TEXT NOT NULL,
      cost REAL NOT NULL
    );`)
  // あとの段階で足した列。前のセッションの表にもなければ足す
  const has = (table: string, column: string) =>
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column)
  // 段階4b: 記憶（方針の文章）を付けて測った計測を、付けない計測と分ける
  if (!has('measurements', 'memory')) {
    db.run(
      "ALTER TABLE measurements ADD COLUMN memory TEXT NOT NULL DEFAULT ''",
    )
  }
  // 段階7: 課題の作業領域（JSON）と、作業領域の課題で成功した試行の差分
  if (!has('tasks', 'workspace')) {
    db.run('ALTER TABLE tasks ADD COLUMN workspace TEXT')
  }
  if (!has('runs', 'patch')) db.run('ALTER TABLE runs ADD COLUMN patch TEXT')
  // 解答役のモデル・推論の深さと課題の組。これが違う計測どうしは比べない（前の列がない計測は、どれとも比べない）
  if (!has('measurements', 'conditions')) {
    db.run('ALTER TABLE measurements ADD COLUMN conditions TEXT')
  }
  const conditions = (split: Split) =>
    `${solverModel()} ${process.env.REASONING || '既定'} 課題 ${db
      .query<{ id: number }, [string]>(
        'SELECT id FROM tasks WHERE split = ? ORDER BY id',
      )
      .all(split)
      .map((t) => t.id)
      .join(',')}`
  const meta = (key: string) =>
    db
      .query<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?',
      )
      .get(key)?.value ?? null
  return {
    db,
    meta,
    conditions,
    setMeta: (key: string, value: string) =>
      db.run(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, value],
      ),
    addTask: (task: EvalTask, split: Split) =>
      db
        .query<
          { id: number },
          [
            string,
            string,
            string,
            string,
            string,
            string,
            number,
            string | null,
          ]
        >(
          'INSERT INTO tasks (split, statement, files, check_command, check_files, solution, created_at, workspace) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        )
        .get(
          split,
          task.statement,
          JSON.stringify(task.files),
          task.check,
          JSON.stringify(task.check_files),
          JSON.stringify(task.solution),
          Date.now(),
          task.workspace ? JSON.stringify(task.workspace) : null,
        )?.id as number,
    reject: (task: EvalTask, reason: string) =>
      db.run('INSERT INTO rejected (task, reason) VALUES (?, ?)', [
        JSON.stringify(task),
        reason,
      ]),
    tasks: (split?: Split): Row[] =>
      db
        .query<Record<string, string | number>, [string | null, string | null]>(
          'SELECT * FROM tasks WHERE (? IS NULL OR split = ?) ORDER BY id',
        )
        .all(split ?? null, split ?? null)
        .map((r) => ({
          id: r.id as number,
          split: r.split as Split,
          statement: r.statement as string,
          files: JSON.parse(r.files as string),
          check: r.check_command as string,
          check_files: JSON.parse(r.check_files as string),
          solution: JSON.parse(r.solution as string),
          ...(r.workspace && { workspace: JSON.parse(r.workspace as string) }),
        })),
    startMeasurement: (
      commit: string,
      split: Split,
      budget: number | null,
      memory = '',
    ) =>
      db
        .query<
          { id: number },
          [string, string, number | null, number, string, string]
        >(
          'INSERT INTO measurements (commit_id, split, budget, started_at, memory, conditions) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        )
        .get(commit, split, budget, Date.now(), memory, conditions(split))
        ?.id as number,
    finishMeasurement: (id: number) =>
      db
        .query<Measurement, [number]>(
          `UPDATE measurements SET
            ok = (SELECT SUM(ok) FROM runs WHERE measurement_id = ?1),
            total = (SELECT COUNT(*) FROM runs WHERE measurement_id = ?1),
            cost = (SELECT SUM(cost) FROM runs WHERE measurement_id = ?1)
            WHERE id = ?1 RETURNING id, ok, total, cost`,
        )
        .get(id) as Measurement,
    addRun: (
      measurement: number,
      task: number,
      ok: boolean,
      cost: number,
      code: number | null,
      patch: string | null = null,
    ) =>
      db
        .query<
          { id: number },
          [number, number, number, number, number | null, string | null]
        >(
          'INSERT INTO runs (measurement_id, task_id, ok, cost, exit_code, patch) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
        )
        .get(measurement, task, ok ? 1 : 0, cost, code, patch)?.id as number,
    addCall: (run: number, context: unknown, reply: unknown, cost: number) =>
      db.run(
        'INSERT INTO calls (run_id, context, reply, cost) VALUES (?, ?, ?, ?)',
        [run, JSON.stringify(context), JSON.stringify(reply), cost],
      ),
  }
}
export type Measure = ReturnType<typeof openMeasure>

// 既にある課題の冒頭。生成役が同じ内容の課題を作らないように見せる
const existing = (m: Measure) => {
  const all = [...m.tasks('val'), ...m.tasks('test')]
  return all.length
    ? `次の課題は既にあります。これらと同じ内容の課題は作らないでください:\n${all.map((t) => `- ${t.statement.split('\n')[0].slice(0, 150)}`).join('\n')}`
    : ''
}

// セッションの作業領域（命令 workspace で設定）に、リポジトリの今のコミットを付けたもの。設定がなければ undefined
export async function currentWorkspace(
  m: Measure,
): Promise<Workspace | undefined> {
  const saved = m.meta('workspace')
  if (!saved) return undefined
  const w = JSON.parse(saved) as Omit<Workspace, 'commit'>
  const commit = (await Bun.$`git -C ${w.repo} rev-parse HEAD`.text()).trim()
  return { ...w, commit }
}

// 候補の agent/ をコミットから取り出す。作業ツリーの未コミットの変更は含まない
export async function checkout(commit: string) {
  const dir = join(DIR, 'candidates', commit)
  if (!existsSync(join(dir, 'agent'))) {
    const temporary = `${dir}.tmp`
    await rm(temporary, { recursive: true, force: true })
    await mkdir(temporary, { recursive: true })
    await Bun.$`git -C ${REPO} archive ${commit} agent | tar -x -C ${temporary}`.quiet()
    await rename(temporary, dir)
  }
  return join(dir, 'agent')
}

// 候補のエージェントを、作業用ディレクトリ work で動かす。隔離環境に見せるのは、作業用ディレクトリ・課題文・
// 候補のコード・モデル中継のソケットだけ。終了コードを返す
export async function runAgent(
  agent: string,
  work: string,
  statement: string,
  complete: Complete,
  budget: Budget,
  onCall: Parameters<typeof serveModel>[3],
  log: string,
  signal?: AbortSignal,
  // 作業領域の課題では、その開発環境の設定と、読み取り専用のディレクトリを隔離環境に渡す
  workspace?: Workspace,
) {
  const root = await mkdtemp(join(tmpdir(), 'hyph-agent-'))
  const socket = join(root, 'model.sock')
  await Bun.write(join(root, 'task.md'), statement)
  const server = serveModel(socket, complete, budget, onCall)
  try {
    const child = Bun.spawn(
      sandboxFor(workspace, work, 'bun /agent/solve.ts', [
        [agent, '/agent'],
        [join(root, 'task.md'), '/task.md'],
        [socket, '/model.sock', 'rw'],
      ]),
      {
        stdout: Bun.file(log),
        stderr: 'inherit',
        timeout: AGENT_TIMEOUT_MS,
        signal,
      },
    )
    return await child.exited
  } finally {
    server.stop(true)
    await rm(root, { recursive: true, force: true })
  }
}

// 1課題を候補に解かせ、判定コマンドで成否を決める
export async function attempt(
  task: EvalTask,
  agent: string,
  complete: Complete,
  budget: Budget,
  onCall: Parameters<typeof serveModel>[3],
  log: string,
  // signal は実行を止める合図、restore は再開するときに作業領域へ戻す tar、onWork は作業用ディレクトリの通知（チェックポイント用）
  options: {
    signal?: AbortSignal
    restore?: Uint8Array
    onWork?: (work: string) => void
  } = {},
) {
  const { signal, restore, onWork } = options
  const work = await mkdtemp(join(tmpdir(), 'hyph-work-'))
  try {
    await prepare(work, task)
    if (restore) await unpack(work, restore)
    onWork?.(work)
    const code = await runAgent(
      agent,
      work,
      task.statement,
      complete,
      budget,
      onCall,
      log,
      signal,
      task.workspace,
    )
    // 障害で解けなかった試行は候補の失敗ではないため記録させず、計測を中断する
    if (budget.outage) {
      throw new Error(`モデルの障害で計測を中断します: ${budget.outage}`)
    }
    const ok = await judge(task, work)
    // 作業領域の課題で成功したら、その差分を返す（hibana への PR の材料）
    const patch = ok && task.workspace ? await diff(work) : null
    return { ok, code, patch }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// 1回の計測。課題ごとに予算を分け、課題の順番や並列の具合で予算の切れ方が変わらないようにする
// 記憶（方針の文章）を課題文の前に置く。記憶がなければ課題文だけ
export const withMemory = (memory: string, statement: string) =>
  memory
    ? `## これまでの経験から得た方針\n${memory}\n\n## 課題\n${statement}`
    : statement

export async function measure(
  m: Measure,
  commit: string,
  split: Split,
  complete: Complete,
  memory = '',
) {
  const tasks = m.tasks(split)
  if (!tasks.length) throw new Error(`${split} の課題がありません`)
  const base = m.meta(`budget:${split}`)
  const limit =
    base === null ? null : (Number(base) / tasks.length) * BUDGET_MARGIN
  const agent = await checkout(commit)
  const id = m.startMeasurement(commit, split, limit, memory)
  await mkdir(join(DIR, 'logs'), { recursive: true })
  // 1課題の試行は数分かかるため、計測と課題の始まりも出して、どこまで進んだかをわかるようにする
  console.log(
    `${commit.slice(0, 7)} の${split}を測ります（課題 ${tasks.length} 件、同時に ${CONCURRENCY} 件）`,
  )
  let next = 0
  let done = 0
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]
      const budget: Budget = { limit, spent: 0 }
      const started = Date.now()
      console.log(`  課題 ${task.id}: 開始`)
      const calls: Parameters<Parameters<typeof serveModel>[3]>[0][] = []
      const { ok, code, patch } = await attempt(
        { ...task, statement: withMemory(memory, task.statement) },
        agent,
        complete,
        budget,
        (call) => calls.push(call),
        join(DIR, 'logs', `measure-${id}-${task.id}.log`),
      )
      const run = m.addRun(id, task.id, ok, budget.spent, code, patch)
      for (const c of calls)
        m.addCall(run, c.context, c.reply, c.reply.usage.cost.total)
      console.log(
        `  課題 ${task.id}: ${ok ? '成功' : '失敗'}（$${budget.spent.toFixed(4)}、${Math.round((Date.now() - started) / 1000)}秒、${++done}/${tasks.length}）`,
      )
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const result = m.finishMeasurement(id)
  // 最初の計測の費用を、その分割の予算の基準にする
  if (base === null && !memory)
    m.setMeta(`budget:${split}`, String(result.cost))
  return result
}

export const summary = (rates: number[]) => {
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length
  const variance =
    rates.length > 1
      ? rates.reduce((a, r) => a + (r - mean) ** 2, 0) / (rates.length - 1)
      : 0
  return { mean, std: Math.sqrt(variance) }
}

// 候補（解答役・改善役）が使うモデルは MODEL・REASONING で選ぶ。課題の生成役と関連性の判定役（固定部）は
// GENERATOR_MODEL・GENERATOR_REASONING で別に選べる。同じモデルでは、候補がときどき解けない正しい課題を作りにくいため
// onCost を渡すと、呼び出しのたびに費用を知らせる（段階5の資源配分の記録）
export async function models(onCost?: (cost: number) => void) {
  const m = createModels({ credentials: fileStore(join(DIR, 'auth.json')) })
  m.setProvider(openaiProvider())
  if (!(await m.getAuth('openai'))) {
    throw new Error(
      `${DIR} で bunx @earendil-works/pi-ai login openai を実行してサインインしてください`,
    )
  }
  // timeoutMs は1回の呼び出しの上限。SDK の既定は10分で、候補の制限時間（10分）と同じため、止まった呼び出しが1回あると試行全体が時間切れになる。
  // 上限を付けるときは SDK の中の呼び直し（既定2回）をやめ、withRetry だけが理由を残して呼び直す
  const load = (
    role: string,
    name: string,
    reasoning?: string,
    timeoutMs?: number,
  ): Complete => {
    const model = m.getModel('openai', name)
    if (!model) throw new Error(`未対応のモデルです: ${name}`)
    console.log(`${role}: ${name}、推論の深さ: ${reasoning ?? '既定'}`)
    const complete: Complete = (context, options) =>
      m.complete(model, context, {
        ...(reasoning && { reasoningEffort: reasoning }),
        ...(timeoutMs && { timeoutMs, maxRetries: 0 }),
        ...options,
      } as never)
    return onCost ? metered(complete, onCost) : complete
  }
  const name = solverModel()
  const reasoning = process.env.REASONING
  return {
    solver: load('候補のモデル', name, reasoning, SOLVER_TIMEOUT_MS),
    generator: load(
      '生成役のモデル',
      process.env.GENERATOR_MODEL || name,
      process.env.GENERATOR_MODEL ? process.env.GENERATOR_REASONING : reasoning,
    ),
  }
}

if (import.meta.main) {
  const [session = '', command, ...args] = process.argv.slice(2)
  // セッション名はファイル名になるため、ディレクトリの外を指せない文字に限る
  if (!/^[\w-]{1,32}$/.test(session)) {
    throw new Error(
      '使い方: bun run measure <セッション> generate|review|run（セッション名は英数字と _ - の32文字以内）',
    )
  }
  await mkdir(join(DIR, 'sessions'), { recursive: true, mode: 0o700 })
  const m = openMeasure(join(DIR, 'sessions', `${session}.sqlite`))
  // 費用は命令ごとの区分で記録する。オフライン RSI は自己改善、経済のループは局所改善、それ以外は検証
  const ledger = openLedger(m)
  const kind: Kind =
    command === 'evolve' || command === 'promote'
      ? 'self'
      : command === 'ideas'
        ? 'local'
        : 'verify'
  const charge = (cost: number) => ledger.record(kind, cost)
  const exhausted = () => {
    if (ledger.remaining(kind) > 0) return false
    console.log(`今期の${KINDS[kind]}の予算を使い切りました`)
    return true
  }
  if (command === 'generate') {
    const [file, val = '8', test = '4'] = args
    if (!file) throw new Error('最終目的のファイルを指定してください')
    const goal = await Bun.file(file).text()
    const saved = m.meta('goal')
    // 課題と予算の基準は最終目的に結び付くため、同じセッションで目的を変えない
    if (saved !== null && saved !== goal) {
      throw new Error(
        'このセッションは別の最終目的で作られています。別のセッション名を使ってください',
      )
    }
    m.setMeta('goal', goal)
    const { generator: complete } = await models(charge)
    const workspace = await currentWorkspace(m)
    // 検証用と成績用は別の呼び出しで作る。同じ内容の課題が両方に入らないよう、既にある課題の冒頭だけを見せる
    for (const [split, count] of [
      ['val', Number(val)],
      ['test', Number(test)],
    ] as const) {
      const r = await generate(
        goal,
        count,
        complete,
        async (task) => {
          const reason = await validate(task, (t) =>
            relevance(goal, t, complete),
          )
          if (reason) {
            m.reject(task, reason)
            console.log(
              `  除外: ${task.statement.slice(0, 60)}\n    ${reason.split('\n')[0]}`,
            )
            return reason
          }
          m.addTask(task, split)
          console.log(`  採用: ${task.statement.slice(0, 60)}`)
          return null
        },
        existing(m),
        workspace,
      )
      console.log(`${split}: 提出 ${r.submitted}、採用 ${r.accepted}`)
    }
  } else if (command === 'workspace') {
    // 課題をリポジトリの上に作るセッションにする。コミットは generate のときの HEAD を使う
    const [repo, prelude, ...mounts] = args
    if (!repo || !prelude) {
      throw new Error(
        '使い方: workspace <リポジトリ> <開発環境の設定のファイル> [読み取り専用で見せるディレクトリ...]',
      )
    }
    await Bun.$`git -C ${repo} rev-parse HEAD`.quiet()
    if (!existsSync(prelude)) throw new Error(`${prelude} がありません`)
    for (const p of mounts) {
      if (!existsSync(p)) throw new Error(`${p} がありません`)
    }
    m.setMeta(
      'workspace',
      JSON.stringify({
        repo: resolve(repo),
        prelude: resolve(prelude),
        mounts: mounts.map((p) => resolve(p)),
      }),
    )
    console.log(`作業領域: ${resolve(repo)}`)
  } else if (command === 'pr') {
    const { pr, candidates } = await import('./pr')
    if (!args[0]) {
      for (const c of candidates(m)) {
        console.log(
          `試行 ${c.run}（課題 ${c.task}、${c.lines}行の差分）: ${c.statement.slice(0, 60)}`,
        )
      }
    } else {
      const { generator } = await models(charge)
      console.log(await pr(m, Number(args[0]), generator))
    }
  } else if (command === 'review') {
    // 抽出確認。課題・解答・判定を同系統のモデルが作るため、最終目的からのずれを人が見る
    // 最終目的に関係しない課題は flag で外す。外した割合を強化の記録に残す
    const all = [...m.tasks('val'), ...m.tasks('test')]
    const n = Math.min(Number(args[0] ?? 3), all.length)
    for (const t of all.sort(() => Math.random() - 0.5).slice(0, n)) {
      console.log(JSON.stringify(t, null, 2))
    }
    m.setMeta('reviewed', String(Number(m.meta('reviewed') ?? 0) + n))
    console.log(
      `関係しない課題は bun run measure ${session} flag <番号> で外してください`,
    )
  } else if (command === 'flag') {
    const id = Number(args[0])
    const changed = m.db.run(
      "UPDATE tasks SET split = 'flagged' WHERE id = ? AND split IN ('val', 'test')",
      [id],
    ).changes
    if (!changed)
      throw new Error(`検証用・成績用に課題 ${args[0]} がありません`)
    m.setMeta('flagged', String(Number(m.meta('flagged') ?? 0) + 1))
    console.log(`課題 ${id} を外しました`)
  } else if (command === 'harden') {
    const [split = 'val', count = '6'] = args
    if (split !== 'val' && split !== 'test') {
      throw new Error('分割は val か test です')
    }
    const { harden, BAND } = await import('./harden')
    const { solver, generator } = await models(charge)
    const r = await harden(m, split, Number(count), solver, generator)
    console.log(
      `提出 ${r.submitted}、選別を通過 ${r.valid}、帯（${BAND.join('〜')}）に入り追加 ${r.added}`,
    )
    console.log(
      '強化前の解けた割合:',
      Object.fromEntries([...r.before].map(([id, x]) => [id, x.rate])),
    )
    console.log(
      '強化後の解けた割合:',
      Object.fromEntries([...r.after].map(([id, x]) => [id, x.rate])),
    )
    console.log(`抽出確認で関係なしとされた割合: ${r.flagged ?? '未確認'}`)
  } else if (command === 'run') {
    const [rev, times = '1', split = 'val'] = args
    if (!rev) throw new Error('コミットを指定してください')
    if (split !== 'val' && split !== 'test') {
      throw new Error('分割は val か test です')
    }
    const commit = (await Bun.$`git -C ${REPO} rev-parse ${rev}`.text()).trim()
    const { solver: complete } = await models(charge)
    const rates: number[] = []
    for (let i = 1; i <= Number(times); i++) {
      console.log(`${commit.slice(0, 7)} の計測 ${i}/${times}`)
      const r = await measure(m, commit, split, complete)
      rates.push(r.ok / r.total)
      console.log(`成功 ${r.ok}/${r.total}、費用 $${r.cost.toFixed(4)}`)
    }
    const { mean, std } = summary(rates)
    console.log(
      `成功率 平均 ${mean.toFixed(3)}、標準偏差 ${std.toFixed(3)}（${rates.length} 回）`,
    )
    console.log(
      `予算の基準（${split} 1回分）: $${Number(m.meta(`budget:${split}`)).toFixed(4)}`,
    )
  } else if (command === 'evolve') {
    const [times = '1', start = 'HEAD', policy = 'simple'] = args
    if (policy !== 'simple' && policy !== 'explore') {
      throw new Error('方式は simple か explore です')
    }
    const { evolve } = await import('./evolve')
    const commit = (
      await Bun.$`git -C ${REPO} rev-parse ${start}`.text()
    ).trim()
    const { solver, generator } = await models(charge)
    for (let i = 1; i <= Number(times); i++) {
      if (exhausted()) break
      console.log(`周回 ${i}/${times}（${policy}）`)
      await evolve(m, commit, solver, generator, policy)
    }
  } else if (command === 'ideas' || command === 'ideas-check') {
    const [n = command === 'ideas' ? '1' : '3'] = args
    if (!/^[1-9]\d*$/.test(n)) throw new Error('回数は正の整数です')
    const { round, check, openIdeas } = await import('./ideas')
    const { solver, generator } = await models(charge)
    if (command === 'ideas-check') await check(m, solver, Number(n))
    for (let i = 1; command === 'ideas' && i <= Number(n); i++) {
      if (exhausted()) break
      console.log(`期 ${i}/${n}`)
      const r = await round(m, solver, generator)
      if (r.adopted) ledger.improved('local', r.delta, r.text)
    }
    console.log('資本:', openIdeas(m).workers())
  } else if (command === 'budget') {
    const [amount] = args
    if (!amount || !(Number(amount) > 0)) {
      throw new Error('1期（1日）の総予算をドルの正の数で指定してください')
    }
    m.setMeta('budget:period', String(Number(amount)))
    console.log(ledger.rows().slice(0, 4))
  } else if (command === 'ledger') {
    console.table(ledger.rows())
  } else if (command === 'deploy') {
    const [rev] = args
    if (!rev) throw new Error('試験版にするコミットを指定してください')
    const commit = (await Bun.$`git -C ${REPO} rev-parse ${rev}`.text()).trim()
    const { openDeploy } = await import('./deploy')
    const stable = openDeploy(m).stable()
    if (!stable) throw new Error('稼働版も基準版もありません')
    if (commit === stable) throw new Error('稼働版と同じコミットです')
    m.setMeta('canary', commit)
    console.log(`試験版: ${commit.slice(0, 7)}、稼働版: ${stable.slice(0, 7)}`)
  } else if (command === 'promote') {
    const [top = '3', repeats = '5'] = args
    if (![top, repeats].every((x) => /^[1-9]\d*$/.test(x))) {
      throw new Error('候補の数と測り直す回数は正の整数です')
    }
    const { promote } = await import('./evolve')
    const { solver } = await models(charge)
    if (exhausted()) process.exit(0)
    const adopted = await promote(m, solver, Number(top), Number(repeats))
    if (adopted) ledger.improved('self', adopted.delta, adopted.commit)
  } else {
    console.log(
      '使い方: bun run measure <セッション> generate|review|run|evolve|promote|deploy|ideas|ideas-check|budget|ledger|harden|flag',
    )
  }
}

// refresh token は更新のたびに入れ替わるため、書き込みを直列にして古い値で上書きしない
function fileStore(path: string): CredentialStore {
  let queue: Promise<unknown> = Promise.resolve()
  const load = async (): Promise<Record<string, Credential>> =>
    (await Bun.file(path).exists()) ? Bun.file(path).json() : {}
  const serial = <T>(task: () => Promise<T>) => {
    const result = queue.then(task)
    queue = result.catch(() => {})
    return result
  }
  return {
    read: async (providerId) => (await load())[providerId],
    list: async () =>
      Object.entries(await load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })),
    modify: (providerId, fn) =>
      serial(async () => {
        const all = await load()
        const next = await fn(all[providerId])
        if (next !== undefined)
          await writeJson(path, { ...all, [providerId]: next })
        return next ?? all[providerId]
      }),
    delete: (providerId) =>
      serial(async () => {
        const { [providerId]: _, ...rest } = await load()
        await writeJson(path, rest)
      }),
  }
}

async function writeJson(path: string, value: unknown) {
  const temporary = `${path}.tmp`
  await Bun.write(temporary, JSON.stringify(value, null, 2))
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}
