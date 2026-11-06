// 開始の合図の後の流れ（ADR 0021）。分解役が課題文を1つ作り、解答役が隔離環境で解き、検査が通れば統合ブランチに積む
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Message, Tool, ToolCall } from '@earendil-works/pi-ai'
import { answerPending, inside, listFiles, object, READ_TOOLS, readFile, runAgent } from './agent.ts'
import { sandboxed } from './sandbox.ts'
import type { Store } from './store.ts'
import type { Call } from './topic.ts'

export const BRANCH = 'hypharness/integration'
// ADR 0010: 検査に落ちたら差し戻し、この回数落ちたら保留にして流れを止める
const MAX_ATTEMPTS = 3

function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
}

const DECOMPOSE = `あなたは hypharness の分解役です。FINAL_GOAL.md（最終目的）と docs/adr の決定を読み、統合ブランチの今のコードと比べて、次にやる課題を1つだけ課題文にします。

- list_files と read_file で、FINAL_GOAL.md、docs/adr、関係するコードを読む。
- 課題は submit_task で出す。title に 40 文字以内の題名を付ける。1つの課題は、1回のコミットで終わる大きさにする。変える振る舞い、受け入れの条件、やらないことを書く。
- 既に終えた課題と同じことは出さない。
- 最終目的を満たしていると判断したら finish を呼ぶ。理由を書く。
- 日本語で書く。修飾表現を使わず、事実を書く。`

const SOLVE = `あなたは hypharness の解答役です。課題文の内容を、作業ツリーのコードに実装します。

- list_files と read_file で読み、write_file で書く。run はコマンドを隔離環境で動かす。隔離環境にはネットワークがない。
- 課題文の受け入れの条件を満たす最小の変更をする。条件に書かれていない機能、抽象化、設定は足さない。
- 終えたら done を呼び、何を変えたかを summary に書く。done の後に検査を動かし、落ちたら出力を返す。
- 日本語で書く。修飾表現を使わず、事実を書く。`

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

export type PipelineOptions = { worktrees: string; setup?: string; check?: string }

// 統合ブランチに課題を積み続ける。finish か保留で終わる。止めた理由を store.halted に残す
export async function runPipeline(store: Store, call: Call, repo: string, options: PipelineOptions) {
  store.setRun({ started: true, halted: '' })
  try {
    if (!git(repo, 'branch', '--list', BRANCH)) git(repo, 'branch', BRANCH, 'HEAD')
    // 前の起動が途中で止まって残した作業ツリーを片付ける
    for (const line of git(repo, 'worktree', 'list', '--porcelain').split('\n')) {
      const tree = line.startsWith('worktree ') ? line.slice(9) : ''
      if (tree.startsWith(`${options.worktrees}/`)) git(repo, 'worktree', 'remove', '--force', tree)
    }
    git(repo, 'worktree', 'prune')
    while (true) {
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
    const done = store.snapshot().tasks.filter((t) => t.state === 'committed')
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
          content: `既に終えた課題:\n${done.map((t) => `- ${t.statement.split('\n')[0]}`).join('\n') || '（なし）'}\n\n次の課題を1つ出してください。`,
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
    await solve(store, call, tree, taskId, next.statement, options.check)
    const commit = git(tree, 'rev-parse', 'HEAD')
    // 作業ツリーを作った後に統合ブランチが動いていたら、上書きせずに止める（その間のコミットを消さない）
    git(repo, 'update-ref', `refs/heads/${BRANCH}`, commit, base)
    store.setTask(taskId, { state: 'committed', commit })
    store.act('solve', 'commit', `${taskId} を ${commit.slice(0, 8)} として統合ブランチに積んだ`)
    if (git(repo, 'remote').split('\n').includes('origin')) git(repo, 'push', 'origin', BRANCH)
    return undefined
  } finally {
    git(repo, 'worktree', 'remove', '--force', tree)
  }
}

async function solve(store: Store, call: Call, tree: string, taskId: string, statement: string, check?: string) {
  const messages: Message[] = [{ role: 'user', content: `課題 ${taskId}:\n${statement}`, timestamp: Date.now() }]
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    store.setTask(taskId, { state: 'solving', attempts: attempt })
    await runAgent({
      store,
      call,
      agent: 'solve',
      taskId,
      system: SOLVE,
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
    })
    store.setTask(taskId, { state: 'checking' })
    git(tree, 'add', '-A')
    const failure = !git(tree, 'status', '--porcelain')
      ? '作業ツリーに変更がありません'
      : check
        ? await sandboxed(tree, check).then(({ code, output }) => (code === 0 ? '' : `検査が終了コード ${code} で落ちました\n${output}`))
        : ''
    if (!failure) {
      // 件名は課題文の最初の文（72 文字まで）、本文に課題文の全体を置く
      const subject = `${taskId}: ${statement.split(/\n|。/)[0].slice(0, 72)}`
      git(tree, '-c', 'user.name=hypharness', '-c', 'user.email=hypharness@localhost', 'commit', '-q', '-m', subject, '-m', statement)
      store.act('solve', 'check', `${taskId} の検査が通った`)
      return
    }
    store.act('solve', 'check', failure.split('\n')[0])
    answerPending(messages, `${failure}\n\n直してから、もう一度 done を呼んでください。`)
  }
  store.setTask(taskId, { state: 'held' })
  throw new Error(`${taskId} が検査に ${MAX_ATTEMPTS} 回落ちたため保留にし、流れを止めました`)
}
