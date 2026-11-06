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
      const finished = await step(store, roles, repo, options)
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
async function step(store: Store, roles: Roles, repo: string, options: PipelineOptions) {
  const n = store.snapshot().tasks.length + 1
  const tree = `${options.worktrees}/t${n}-${Date.now()}`
  mkdirSync(dirname(tree), { recursive: true })
  const base = git(repo, 'rev-parse', BRANCH)
  git(repo, 'worktree', 'add', '--detach', tree, base)
  try {
    // 最終目的の本文は対話の状態にある（画面で書き換えたもの）。作業ツリーにも書き、最初の課題のコミットに入れる（ADR 0003）
    writeFileSync(join(tree, 'FINAL_GOAL.md'), store.snapshot().goal.text)
    const next = await roles.decompose({ role: 'decompose', taskId: `t${n}`, tree })
    if ('finish' in next) return next.finish
    const taskId = store.addTask(next.statement)
    if (options.setup) {
      // 準備はホストで動かす。依存の取得などネットワークが要る処理のため
      const setup = Bun.spawnSync(['sh', '-c', options.setup], { cwd: tree, stdout: 'pipe', stderr: 'pipe' })
      if (setup.exitCode !== 0) throw new Error(`準備のコマンドが失敗しました: ${setup.stderr.toString().slice(-2000)}`)
    }
    const summary = await solve(store, roles, tree, taskId, next.statement, options)
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

// 課題を解く。解答役の試行と検査を繰り返し、検査が通れば done の summary を返す
async function solve(store: Store, roles: Roles, tree: string, taskId: string, statement: string, options: PipelineOptions) {
  let messages: Message[] = []
  // 最後の検査の失敗の出力。次の試行に渡し、保留にしたときの理由にも使う
  let reason = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
  throw new Error(`${taskId} が検査に ${MAX_ATTEMPTS} 回落ちたため保留にし、流れを止めました。理由: ${reason.slice(-1000)}`)
}
