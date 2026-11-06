// 開始の合図の後の流れ（ADR 0021）。分解役が課題文を1つ作り、解答役が隔離環境で解き、検査が通れば統合ブランチに積む
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import { answerPending, inside, listFiles, object, READ_TOOLS, readFile, runAgent } from './agent.ts'
import { sandboxed } from './sandbox.ts'
import type { Store } from './store.ts'
import { CostLimitError } from './topic.ts'
import type { Call } from './topic.ts'

export const BRANCH = 'hypharness/integration'
// ADR 0010: 検査に落ちたら差し戻し、この回数落ちたら保留にして流れを止める
const MAX_ATTEMPTS = 3
// 課題の記録に残す差分の長さ。超える分は末尾を残して先頭を切る
const MAX_DIFF = 8000

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

const DECOMPOSE = `あなたは hypharness の分解役です。最終目的の本文と、統合ブランチの今のコードを比べて、次にやる課題を1つだけ課題文にします。

- 最終目的は、会話で渡す FINAL_GOAL.md の本文だけである。完了を判断するのは、この本文に書かれたことを満たしたかどうかだけにする。
- docs/adr の決定は、最終目的の満たし方の制約であって、最終目的ではない。ADR に書かれていて本文に書かれていないことを、課題にしない。
- list_files と read_file で、関係するコードと ADR を読む。
- 課題は submit_task で出す。title に 40 文字以内の題名を付ける。1つの課題は、1回のコミットで終わる大きさにする。変える振る舞い、受け入れの条件、やらないことを書く。
- 既に終えた課題と同じことは出さない。
- 本文に書かれたことをすべて満たしていると判断したら、課題を出さずに finish を呼ぶ。理由を書く。
- 日本語で書く。修飾表現を使わず、事実を書く。`

const SOLVE = `あなたは hypharness の解答役です。課題文の内容を、作業ツリーのコードに実装します。

- list_files と read_file で読み、write_file で書く。run はコマンドを隔離環境で動かす。隔離環境にはネットワークがない。
- 課題文の受け入れの条件を満たす最小の変更をする。条件に書かれていない機能、抽象化、設定は足さない。
- 終えたら done を呼び、何を変えたかを summary に書く。done の後に検査を動かし、落ちたら出力を返す。
- 日本語で書く。修飾表現を使わず、事実を書く。`

// 経験の一覧に入れる項目の根拠の形。パイプラインが実行の結果から書いた項目だけに合う
const EXECUTION = /^課題 t\d+ の(コミット \S+|検査の終了コード \S+)$/

// プロンプトが課題の数だけ伸びないための上限
const MAX_EXPERIENCE = 20

// 解答役のシステムプロンプトに付ける、共有文脈から作った経験の一覧（ADR 0004）
function experience(store: Store) {
  const entries = store
    .snapshot()
    .entries.filter((e) => EXECUTION.test(e.evidence))
    .slice(-MAX_EXPERIENCE)
    .reverse()
  if (entries.length === 0) return ''
  const lines = entries.map((e) => `- ${e.kind}: ${e.text.split('\n').join(' / ')}（根拠: ${e.evidence}）`)
  return `\n\n共有文脈から作った経験の一覧（新しい順）:\n${lines.join('\n')}`
}

const DECOMPOSE_TOOLS = [
  ...READ_TOOLS,
  {
    name: 'submit_task',
    description: '次の課題を出す。title はコミットの件名になる',
    parameters: object(
      { title: { type: 'string', description: '40 文字以内の題名' }, statement: { type: 'string' } },
      ['title', 'statement'],
    ),
  },
  {
    name: 'finish',
    description: '最終目的を満たしたときに呼ぶ',
    parameters: object({ reason: { type: 'string' } }, ['reason']),
  },
] as Tool[]

const SOLVE_TOOLS = [
  ...READ_TOOLS,
  {
    name: 'write_file',
    description: '作業ツリーのファイルを content で置き換える。ないファイルは作る',
    parameters: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'run',
    description: 'コマンドを作業ツリーで、隔離環境の中で動かす。ネットワークはない',
    parameters: object({ command: { type: 'string' } }, ['command']),
  },
  {
    name: 'done',
    description: '実装を終えたときに呼ぶ',
    parameters: object({ summary: { type: 'string' } }, ['summary']),
  },
] as Tool[]

const arg = (call: ToolCall, name: string) => String((call.arguments as Record<string, unknown>)[name] ?? '')

// 分解役に渡すユーザーメッセージ。終えた課題、保留にした課題とその理由、保留の割合を入れる（ADR 0010）
function decomposeMessage(store: Store) {
  const tasks = store.snapshot().tasks
  const first = (text: string) => text.split('\n')[0]
  const done = tasks.filter((t) => t.state === 'committed')
  const held = tasks.filter((t) => t.state === 'held')
  const lines = [
    `既に終えた課題:\n${done.map((t) => `- ${first(t.statement)}`).join('\n') || '（なし）'}`,
    `保留にした課題:\n${held.map((t) => `- ${t.id}: ${first(t.statement)}（保留の理由: ${first(t.reason)}）`).join('\n') || '（なし）'}`,
  ]
  if (tasks.length > 0) lines.push(`保留 ${held.length} / 課題 ${tasks.length}`)
  lines.push('本文をすべて満たしていれば finish を、まだなら次の課題を1つ出してください。')
  return lines.join('\n\n')
}

export type PipelineOptions = {
  worktrees: string
  setup?: string
  check?: string
  // 中継が持つ、課題1つあたりに使った費用（ドル）と、その上限（ADR 0011）。保留の理由に使う
  spent?: (taskId: string) => number
  limitUsd?: number
}

// 統合ブランチに課題を積み続ける。finish か保留で終わる。止めた理由を store.halted に残す
export async function runPipeline(store: Store, call: Call, repo: string, options: PipelineOptions) {
  store.setRun({ started: true, halted: '', stopping: false })
  try {
    if (!git(repo, 'branch', '--list', BRANCH)) git(repo, 'branch', BRANCH, 'HEAD')
    // 前の起動が途中で止まって残した作業ツリーを片付ける
    for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
      const tree = line.startsWith('worktree ') ? line.slice(9) : ''
      if (tree.startsWith(`${options.worktrees}/`)) git(repo, 'worktree', 'remove', '--force', tree)
    }
    git(repo, 'worktree', 'prune')
    while (true) {
      // 利用者が止めるボタンを押していたら、次の課題に入らずに止める
      if (store.snapshot().stopping) {
        store.setRun({ started: false, halted: '利用者が止めました', stopping: false })
        return
      }
      const finished = await step(store, call, repo, options)
      if (finished !== undefined) {
        store.act('decompose', 'commit', `最終目的を満たした: ${finished}`)
        store.setRun({ started: false, halted: '' })
        return
      }
    }
  } catch (e) {
    const reason = (e as Error).message
    store.act('solve', 'fail', reason)
    holdUnfinished(store)
    store.setRun({ started: false, halted: reason })
  }
}

// 途中で止まった課題を保留にする。「解いている」のまま残さない
export function holdUnfinished(store: Store) {
  for (const t of store.snapshot().tasks) {
    if (t.state === 'solving' || t.state === 'checking') store.setTask(t.id, { state: 'held' })
  }
}

// 課題を1つ進める。最終目的を満たしていれば finish の理由を返す
async function step(store: Store, call: Call, repo: string, options: PipelineOptions) {
  const n = store.snapshot().tasks.length + 1
  const tree = `${options.worktrees}/t${n}-${Date.now()}`
  mkdirSync(dirname(tree), { recursive: true })
  const base = git(repo, 'rev-parse', BRANCH)
  git(repo, 'worktree', 'add', '--detach', tree, base)
  try {
    // 最終目的の本文は対話の状態にある（画面で書き換えたもの）。作業ツリーにも書き、最初の課題のコミットに入れる（ADR 0003）
    const goal = store.snapshot().goal.text
    writeFileSync(join(tree, 'FINAL_GOAL.md'), goal)
    const next = await runAgent<{ statement: string } | { finish: string }>({
      store,
      call,
      agent: 'decompose',
      taskId: `t${n}`,
      system: DECOMPOSE,
      tools: DECOMPOSE_TOOLS,
      messages: [
        {
          role: 'user',
          content: `最終目的（FINAL_GOAL.md）の本文:\n\n${goal}\n\n${decomposeMessage(store)}`,
          timestamp: Date.now(),
        },
      ],
      run: async (c) => (c.name === 'list_files' ? listFiles(tree, arg(c, 'path')) : readFile(tree, arg(c, 'path'))),
      stop: (c) =>
        c.name === 'submit_task'
          ? { statement: `${arg(c, 'title') || arg(c, 'statement').split('\n')[0]}\n\n${arg(c, 'statement')}` }
          : c.name === 'finish'
            ? { finish: arg(c, 'reason') }
            : undefined,
    })
    if ('finish' in next) return next.finish
    const taskId = store.addTask(next.statement)
    if (options.setup) {
      // 準備はホストで動かす。依存の取得などネットワークが要る処理のため
      const setup = Bun.spawnSync(['sh', '-c', options.setup], { cwd: tree, stdout: 'pipe', stderr: 'pipe' })
      if (setup.exitCode !== 0) throw new Error(`準備のコマンドが失敗しました: ${setup.stderr.toString().slice(-2000)}`)
    }
    const summary = await solve(store, call, tree, taskId, next.statement, options)
    const commit = git(tree, 'rev-parse', 'HEAD')
    // 作業ツリーを作った後に統合ブランチが動いていたら、上書きせずに止める（その間のコミットを消さない）
    try {
      git(repo, 'update-ref', `refs/heads/${BRANCH}`, commit, base)
    } catch (e) {
      store.setTask(taskId, { state: 'held', reason: (e as Error).message })
      throw e
    }
    store.record({
      topicId: 'solve',
      kind: 'fact',
      text: `${next.statement.split('\n')[0]}\n変えた点: ${summary}`,
      evidence: `課題 ${taskId} のコミット ${commit.slice(0, 8)}`,
    })
    store.act('solve', 'commit', `${taskId} を ${commit.slice(0, 8)} として統合ブランチに積んだ`)
    if (git(repo, 'remote').split('\n').includes('origin')) git(repo, 'push', 'origin', BRANCH)
    return undefined
  } finally {
    git(repo, 'worktree', 'remove', '--force', tree)
  }
}

// 課題を解く。検査が通れば done の summary を返す
async function solve(store: Store, call: Call, tree: string, taskId: string, statement: string, options: PipelineOptions) {
  const messages: Message[] = [{ role: 'user', content: `課題 ${taskId}:\n${statement}`, timestamp: Date.now() }]
  // 最後の検査の失敗の出力。保留にしたときの理由に使う
  let reason = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    store.setTask(taskId, { state: 'solving', attempts: attempt })
    const summary = await runAgent<string>({
      store,
      call,
      agent: 'solve',
      taskId,
      system: SOLVE + experience(store),
      tools: SOLVE_TOOLS,
      messages,
      run: async (c) => {
        if (c.name === 'list_files') return listFiles(tree, arg(c, 'path'))
        if (c.name === 'read_file') return readFile(tree, arg(c, 'path'))
        if (c.name === 'write_file') {
          await Bun.write(inside(tree, arg(c, 'path')), arg(c, 'content'))
          return `書いた: ${arg(c, 'path')}`
        }
        if (c.name === 'run') {
          const { code, output } = await sandboxed(tree, arg(c, 'command'))
          return `終了コード ${code}\n${output}`
        }
        throw new Error(`未知のツールです: ${c.name}`)
      },
      stop: (c) => (c.name === 'done' ? arg(c, 'summary') : undefined),
    }).catch((e: Error) => {
      // 中継が費用の上限に達して断ったときは、この課題を保留にし、断りの文と使った費用を残して流れを止める
      if (!(e instanceof CostLimitError)) throw e
      const spent = options.spent?.(taskId) ?? 0
      store.setTask(taskId, { state: 'held', reason: e.message, spent })
      throw new Error(
        `課題 ${taskId} が費用の上限 ${options.limitUsd} ドルに達しました（使った費用 ${spent} ドル）。保留にして流れを止めました。理由: ${e.message}`,
      )
    })
    store.setTask(taskId, { state: 'checking' })
    git(tree, 'add', '-A')
    let failure: { text: string; code: string } | undefined
    if (!git(tree, 'status', '--porcelain')) failure = { text: '作業ツリーに変更がありません', code: 'なし' }
    else if (options.check) {
      const { code, output } = await sandboxed(tree, options.check)
      if (code !== 0) failure = { text: `検査が終了コード ${code} で落ちました\n${output}`, code: String(code) }
    }
    if (!failure) {
      // 件名は課題文の最初の文（72 文字まで）、本文に課題文の全体を置く
      const subject = `${taskId}: ${statement.split(/\n|。/)[0].slice(0, 72)}`
      git(tree, '-c', 'user.name=hypharness', '-c', 'user.email=hypharness@localhost', 'commit', '-q', '-m', subject, '-m', statement)
      store.act('solve', 'check', `${taskId} の検査が通った`)
      const commit = git(tree, 'rev-parse', 'HEAD')
      const patch = git(tree, 'show', '--format=', '--patch', commit)
      store.setTask(taskId, { state: 'committed', commit, diff: patch.slice(-MAX_DIFF) })
      return summary
    }
    reason = failure.text
    store.act('solve', 'check', failure.text.split('\n')[0])
    // 差し戻し1回ごとに、検査の失敗を共有文脈に残す。3回落ちて保留にしたときは、この最後の記録が残る
    store.record({
      topicId: 'solve',
      kind: 'fail',
      text: failure.text.split('\n')[0],
      evidence: `課題 ${taskId} の検査の終了コード ${failure.code}`,
    })
    answerPending(messages, `${failure.text}\n\n直してから、もう一度 done を呼んでください。`)
  }
  const spent = options.spent?.(taskId) ?? 0
  store.setTask(taskId, { state: 'held', reason, spent })
  throw new Error(
    `${taskId} が検査に ${MAX_ATTEMPTS} 回落ちたため保留にし、流れを止めました。理由: ${reason.slice(-1000)}`,
  )
}
