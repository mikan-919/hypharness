import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sandboxed } from './sandbox.ts'

test('git worktree の中では、元のリポジトリの履歴を読めるが、コミットはできない', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'hyph-sandbox-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  git('init', '-q')
  git('commit', '-q', '--allow-empty', '-m', '最初のコミット')
  const tree = join(mkdtempSync(join(tmpdir(), 'hyph-sandbox-tree-')), 'tree')
  git('worktree', 'add', '-q', '--detach', tree)
  const log = await sandboxed(tree, 'git log --format=%s')
  expect(log).toEqual({ code: 0, output: '最初のコミット\n', stdout: '最初のコミット\n', stderr: '' })
  const commit = await sandboxed(tree, 'git -c user.name=t -c user.email=t@t commit -q --allow-empty -m 次')
  expect(commit.code).not.toBe(0)
})
