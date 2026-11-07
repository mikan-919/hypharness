// 開始の合図の後の流れ（固定部、ADR 0021、0022）。作業ツリーを用意し、分解役に課題文を1つ作らせ、解答役に解かせ、
// 検査が通れば統合ブランチに積む。分解役と解答役（改良の対象）は Roles として受け取る
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message } from '@earendil-works/pi-ai'
import { sandboxed } from '../harness/sandbox.ts'
import { CostLimitError, type DecomposeResult, type Job, type SolveResult } from '../shared/contract.ts'
import type { Store } from './store.ts'

export const BRANCH = 'hypharness/integration'
// ADR 0010: 検査に落ちたら差し戻し、この回数落ちたら保留にして流れを止める
const MAX_ATTEMPTS = 3
// 課題の記録に残す差分の長さ。超える分は末尾を残して先頭を切る
const MAX_DIFF = 8000

export type Roles = {
  decompose(job: Extract<Job, { role: 'decompose' }>): Promise<DecomposeResult>
  solve(job: Extract<Job, { role: 'solve' }>): Promise<SolveResult>
}

export function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', repo, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString().trim()}`)
  return result.stdout.toString().trim()
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
export async function runPipeline(store: Store, roles: Roles, repo: string, options: PipelineOptions) {
  store.setRun({ started: true, halted: '', stopping: false, finished: '' })
  try {
    if (!git(repo, 'branch', '--list', BRANCH)) git(repo, 'branch', BRANCH, 'HEAD')
    // 前の起動が途中で止まって残した作業ツリーを片付ける。途中の課題の作業ツリーは、続きを解くために残す
    const keep = unfinished(store, repo, options.worktrees)?.tree
    for (const tree of trees(repo, options.worktrees)) if (tree !== keep) git(repo, 'worktree', 'remove', '--force', tree)
    git(repo, 'worktree', 'prune')
    if (!keep) holdUnfinished(store, '前の起動で途中まで解いた作業ツリーが残っていない')
    while (true) {
      // 利用者が止めるボタンを押していたら、次の課題に入らずに止める
      if (store.snapshot().stopping) {
        holdUnfinished(store, '利用者が止めました')
        store.setRun({ started: false, halted: '利用者が止めました', stopping: false })
        return
      }
      const finished = await step(store, roles, repo, options)
      if (finished !== undefined) {
        store.act('decompose', 'commit', `最終目的を満たした: ${finished}`)
        store.setRun({ started: false, halted: '', finished })
        return
      }
    }
  } catch (e) {
    const reason = (e as Error).message
    store.act('solve', 'fail', reason)
    holdUnfinished(store, reason)
    store.setRun({ started: false, halted: reason })
  }
}

// 途中で止まった課題を保留にする。「解いている」のまま残さない
export function holdUnfinished(store: Store, reason = '流れが途中で止まった') {
  for (const t of store.snapshot().tasks) {
    if (t.state === 'solving' || t.state === 'checking') store.setTask(t.id, { state: 'held', reason: t.reason || reason })
  }
}

// この流れの作業ツリーの一覧
function trees(repo: string, worktrees: string) {
  return git(repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((line) => line.startsWith(`worktree ${worktrees}/`))
    .map((line) => line.slice(9))
}

// 前の起動が途中で止めた課題と、その作業ツリー。解いている途中か、検査に通って統合ブランチに積む前に止まった課題
export function unfinished(store: Store, repo: string, worktrees: string) {
  const task = store.snapshot().tasks.at(-1)
  if (!task) return undefined
  const tree = trees(repo, worktrees).find((t) => t.startsWith(`${worktrees}/${task.id}-`))
  if (!tree) return undefined
  const pending = task.state === 'solving' || task.state === 'checking'
  const unpushed = task.state === 'committed' && Bun.spawnSync(['git', '-C', repo, 'merge-base', '--is-ancestor', task.commit, BRANCH]).exitCode !== 0
  return pending || unpushed ? { task, tree } : undefined
}

// 課題を1つ進める。最終目的を満たしていれば finish の理由を返す。前の起動が途中で止めた課題があれば、その続きから進める
async function step(store: Store, roles: Roles, repo: string, options: PipelineOptions) {
  const resumed = unfinished(store, repo, options.worktrees)
  const n = store.snapshot().tasks.length + 1
  const tree = resumed?.tree ?? `${options.worktrees}/t${n}-${Date.now()}`
  // 作業ツリーは統合ブランチの先端から作り、検査に通るまでコミットしない。積んだ課題の続きなら、その親が元
  const base = resumed
    ? git(tree, 'rev-parse', resumed.task.state === 'committed' ? 'HEAD^' : 'HEAD')
    : git(repo, 'rev-parse', BRANCH)
  if (!resumed) {
    mkdirSync(dirname(tree), { recursive: true })
    git(repo, 'worktree', 'add', '--detach', tree, base)
  }
  try {
    let taskId: string
    let statement: string
    if (resumed) {
      ;({ id: taskId, statement } = resumed.task)
      store.act('solve', 'text', `${taskId} を前の起動の続きから進める`)
    } else {
      // 最終目的の本文は対話の状態にある（画面で書き換えたもの）。作業ツリーにも書き、最初の課題のコミットに入れる（ADR 0003）
      writeFileSync(join(tree, 'FINAL_GOAL.md'), store.snapshot().goal.text)
      const next = await roles.decompose({ role: 'decompose', taskId: `t${n}`, tree })
      if ('finish' in next) return next.finish
      statement = next.statement
      taskId = store.addTask(statement)
      if (options.setup) {
        // 準備はホストで動かす。依存の取得などネットワークが要る処理のため
        const setup = Bun.spawnSync(['sh', '-c', options.setup], { cwd: tree, stdout: 'pipe', stderr: 'pipe' })
        if (setup.exitCode !== 0) throw new Error(`準備のコマンドが失敗しました: ${setup.stderr.toString().slice(-2000)}`)
      }
    }
    const summary =
      resumed?.task.state === 'committed'
        ? '前の起動で検査に通った変更'
        : await solve(store, roles, tree, taskId, statement, options, resumed?.task.attempts ?? 0)
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
      text: `${statement.split('\n')[0]}\n変えた点: ${summary}`,
      evidence: `課題 ${taskId} のコミット ${commit.slice(0, 8)}`,
    })
    store.act('solve', 'commit', `${taskId} を ${commit.slice(0, 8)} として統合ブランチに積んだ`)
    if (git(repo, 'remote').split('\n').includes('origin')) git(repo, 'push', 'origin', BRANCH)
    return undefined
  } finally {
    git(repo, 'worktree', 'remove', '--force', tree)
  }
}

// 課題を解く。解答役の試行と検査を繰り返し、検査が通れば done の summary を返す。
// 試行ごとの会話を保存し、再起動の後は、前の起動で終えた試行の会話と試行の回数から続ける
async function solve(store: Store, roles: Roles, tree: string, taskId: string, statement: string, options: PipelineOptions, tried = 0) {
  const key = `solve:${taskId}`
  let messages: Message[] = (tried > 0 && store.transcript(key)) || []
  // 最後の検査の失敗の出力。次の試行に渡し、保留にしたときの理由にも使う
  let reason = tried > 0 ? '前の起動がこの課題の途中で止まった。作業ツリーには途中までの変更が残っている。git status で確かめてから続けてください。' : ''
  // ponytail: 途中で止まった試行は、その試行の会話を失い、同じ回としてやり直す。試行の途中の会話まで要るなら、エージェントの1ターンごとに保存する
  for (let attempt = Math.max(tried, 1); attempt <= MAX_ATTEMPTS; attempt++) {
    store.setTask(taskId, { state: 'solving', attempts: attempt })
    const result = await roles.solve({ role: 'solve', taskId, tree, statement, messages, failure: reason }).catch((e: Error) => {
      // 中継が費用の上限に達して断ったときは、この課題を保留にし、断りの文と使った費用を残して流れを止める
      if (!(e instanceof CostLimitError)) throw e
      const spent = options.spent?.(taskId) ?? 0
      store.setTask(taskId, { state: 'held', reason: e.message, spent })
      throw new Error(
        `課題 ${taskId} が費用の上限 ${options.limitUsd} ドルに達しました（使った費用 ${spent} ドル）。保留にして流れを止めました。理由: ${e.message}`,
      )
    })
    messages = result.messages
    store.saveTranscript(key, messages)
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
      // 終えた課題の会話は再開に使わないので捨てる。保存のファイルを大きくしない
      store.saveTranscript(key, [])
      return result.summary
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
  }
  const spent = options.spent?.(taskId) ?? 0
  store.setTask(taskId, { state: 'held', reason, spent })
  store.saveTranscript(key, [])
  throw new Error(`${taskId} が検査に ${MAX_ATTEMPTS} 回落ちたため保留にし、流れを止めました。理由: ${reason.slice(-1000)}`)
}
