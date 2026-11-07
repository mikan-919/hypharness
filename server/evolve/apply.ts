// 候補の変更をコードに当ててから検査する（最終目的の 6）。変更の文は解答役が実装し、検査を通るかで報酬を決める。
// 当てた差分は候補に残し、次の周はその差分を出発点に積む
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { solve } from '../../harness/roles.ts'
import { sandboxed } from '../../harness/sandbox.ts'
import type { Call } from '../../harness/topic.ts'
import type { AgentStore } from '../../shared/contract.ts'
import { MODULE_SUMMARY, type Candidate } from '../../shared/evolve.ts'
import { BRANCH, git } from '../pipeline.ts'
import { createStore } from '../store.ts'

export type ApplyOptions = {
  // ハーネスのリポジトリ。統合ブランチがあればその先端、なければ HEAD から始める
  repo: string
  // 解答役が呼ぶモデル
  call: Call
  // 検査のコマンド。隔離環境で動かす
  check: string
  // 出発点の候補。統合ブランチに積んでいなければ、差分を先に当てる
  parent?: Candidate
  // 検査に通ったら、統合ブランチに比較して上書き（CAS）で積む。積めなければ 0 にする
  adopt?: boolean
  // 解答役の動きを残す対話の状態。固定部は画面とつながるものを渡す
  store?: AgentStore
}

const statement = (c: Candidate) =>
  [
    `ハーネスの ${c.module}（${MODULE_SUMMARY[c.module]}）を、次のとおり変える。`,
    ...c.changes.map((change) => `- ${change}`),
    '',
    `仕様は docs/specs/${c.module}.md にある。変えた振る舞いに合わせて、仕様とテストも直す。`,
  ].join('\n')

// 候補の変更を一時的な作業ツリーで当てて検査し、0 か 1 を返す。当てた差分は candidate.diff に入れる
export async function applyAndCheck(candidate: Candidate, options: ApplyOptions): Promise<0 | 1> {
  const { repo, call, check, parent, adopt, store = createStore() } = options
  const hasBranch = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '-q', BRANCH]).exitCode === 0
  const base = git(repo, 'rev-parse', hasBranch ? BRANCH : 'HEAD')
  const tree = mkdtempSync(join(tmpdir(), 'hyph-evo-'))
  git(repo, 'worktree', 'add', '-q', '--detach', tree, base)
  try {
    // 依存はホストで入れる。ハーネスの node_modules へのリンクは、ホームディレクトリが空の隔離環境から見えない
    if (existsSync(join(tree, 'package.json'))) {
      const install = Bun.spawnSync(['bun', 'install', '--frozen-lockfile'], { cwd: tree, stderr: 'pipe' })
      if (install.exitCode !== 0) throw new Error(`依存を入れられませんでした: ${install.stderr.toString().trim()}`)
    }
    if (parent?.diff && !parent.commit) {
      const applied = Bun.spawnSync(['git', '-C', tree, 'apply', '--index', '-'], { stdin: Buffer.from(parent.diff), stderr: 'pipe' })
      if (applied.exitCode !== 0) {
        candidate.note = `${candidate.note}\n出発点 ${parent.id} の差分を当てられませんでした: ${applied.stderr.toString().trim()}`.trim()
        return 0
      }
    }
    try {
      await solve(store, call, { role: 'solve', taskId: candidate.id, tree, statement: statement(candidate), messages: [], failure: '' })
    } catch (e) {
      candidate.note = `${candidate.note}\n解答役が変更を当てられませんでした: ${(e as Error).message}`.trim()
      return 0
    }
    git(tree, 'add', '-A')
    const diff = git(tree, 'diff', '--cached', base)
    if (!diff) {
      candidate.note = `${candidate.note}\n解答役はコードを変えませんでした`.trim()
      return 0
    }
    candidate.diff = `${diff}\n`
    const result = await sandboxed(tree, check)
    candidate.checkOutput = { stdout: result.stdout, stderr: result.stderr }
    if (result.code !== 0) {
      const note = candidate.note.trim()
      const output = result.stdout + result.stderr
      candidate.note = `${note ? `${note}\n` : ''}検査に落ちました: ${output}`
      return 0
    }
    if (!adopt) return 1
    const summary = `${candidate.id}: ${candidate.module} の自己改良`
    git(tree, '-c', 'user.name=hypharness', '-c', 'user.email=hypharness@localhost', 'commit', '-q', '-m', summary, '-m', candidate.changes.map((c) => `- ${c}`).join('\n'))
    const commit = git(tree, 'rev-parse', 'HEAD')
    try {
      // 周の間に流れが統合ブランチを進めていたら積まない
      git(repo, 'update-ref', `refs/heads/${BRANCH}`, commit, hasBranch ? base : '0'.repeat(40))
    } catch (e) {
      candidate.note = `${candidate.note}\n統合ブランチに積めませんでした: ${(e as Error).message}`.trim()
      return 0
    }
    candidate.commit = commit
    if (git(repo, 'remote').split('\n').includes('origin')) git(repo, 'push', 'origin', BRANCH)
    return 1
  } finally {
    Bun.spawnSync(['git', '-C', repo, 'worktree', 'remove', '--force', tree])
  }
}
