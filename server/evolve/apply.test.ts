import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { Call } from '../../harness/topic.ts'
import type { Candidate } from '../../shared/evolve.ts'
import { applyAndCheck } from './apply.ts'

process.env.HYPH_CTX_DIR = mkdtempSync(join(tmpdir(), 'hyph-ctx-'))

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'hyph-evo-repo-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args])
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

const reply = (name: string, args: object): AssistantMessage =>
  ({ role: 'assistant', content: [{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args }] }) as unknown as AssistantMessage

// path にファイルを書いて done を呼ぶ解答役
const writes = (path: string): Call => {
  const replies = [reply('write_file', { path, content: 'x\n' }), reply('done', { summary: '書いた' })]
  return async () => replies.shift()!
}

const candidate = (id: string, parent?: string): Candidate => ({
  id,
  round: 1,
  module: 'context',
  changes: ['作業文脈を変える'],
  score: 0,
  note: '',
  cost: 0,
  ...(parent ? { parent } : {}),
})

test('解答役が当てた差分を候補に残し、出発点の差分に積んで検査する', async () => {
  const repo = harness()
  const first = candidate('1-4')
  expect(await applyAndCheck(first, { repo, call: writes('a.txt'), check: 'test -f a.txt' })).toBe(1)
  expect(first.diff).toContain('+++ b/a.txt')
  expect(first.diff).not.toContain('node_modules')

  const second = candidate('2-4', first.id)
  expect(await applyAndCheck(second, { repo, call: writes('b.txt'), check: 'test -f a.txt && test -f b.txt', parent: first })).toBe(1)
  expect(second.diff).toContain('+++ b/a.txt')
  expect(second.diff).toContain('+++ b/b.txt')
})

test('検査に落ちたら 0 にし、理由を note に残す。作業ツリーは消す', async () => {
  const repo = harness()
  const c = candidate('1-4')
  expect(await applyAndCheck(c, { repo, call: writes('a.txt'), check: 'echo だめ; exit 1' })).toBe(0)
  expect(c.note).toContain('だめ')
  const worktrees = Bun.spawnSync(['git', '-C', repo, 'worktree', 'list']).stdout.toString().trim().split('\n')
  expect(worktrees).toHaveLength(1)
})

test('解答役がコードを変えなければ 0 にする', async () => {
  const repo = harness()
  const c = candidate('1-4')
  const call: Call = async () => reply('done', { summary: '何もしない' })
  expect(await applyAndCheck(c, { repo, call, check: 'true' })).toBe(0)
  expect(c.note).toContain('コードを変えませんでした')
})
