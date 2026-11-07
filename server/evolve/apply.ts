// 候補の変更をコードに当ててから検査する（最終目的の 6）。変更の文は解答役が実装し、検査を通るかで報酬を決める。
// 当てた差分は候補に残し、次の周はその差分を出発点に積む
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { solve } from '../../harness/roles.ts'
import { sandboxed } from '../../harness/sandbox.ts'
import type { Call } from '../../harness/topic.ts'
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
  // 出発点の候補。差分を先に当てる
  parent?: Candidate
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
  const { repo, call, check, parent } = options
  const base = Bun.spawnSync(['git', '-C', repo, 'rev-parse', '--verify', '-q', BRANCH]).exitCode === 0 ? BRANCH : 'HEAD'
  const tree = mkdtempSync(join(tmpdir(), 'hyph-evo-'))
  git(repo, 'worktree', 'add', '-q', '--detach', tree, base)
  try {
    // ponytail: node_modules はハーネスのものを共有する。依存を足す変更は当てられずに落ちる
    symlinkSync(join(repo, 'node_modules'), join(tree, 'node_modules'))
    if (parent?.diff) {
      const applied = Bun.spawnSync(['git', '-C', tree, 'apply', '--index', '-'], { stdin: Buffer.from(parent.diff), stderr: 'pipe' })
      if (applied.exitCode !== 0) {
        candidate.note = `${candidate.note}\n出発点 ${parent.id} の差分を当てられませんでした: ${applied.stderr.toString().trim()}`.trim()
        return 0
      }
    }
    try {
      await solve(createStore(), call, { role: 'solve', taskId: candidate.id, tree, statement: statement(candidate), messages: [], failure: '' })
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
    if (result.code !== 0) candidate.note = `${candidate.note}\n検査に落ちました: ${result.output.slice(-1000)}`.trim()
    return result.code === 0 ? 1 : 0
  } finally {
    Bun.spawnSync(['git', '-C', repo, 'worktree', 'remove', '--force', tree])
  }
}
