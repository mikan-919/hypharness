import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { BRANCH, runPipeline } from './pipeline.ts'
import { createStore } from './store.ts'
import type { Call } from './topic.ts'

const reply = (name: string, args: object) =>
  ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: `${name}-${Math.random()}`, name, arguments: args }],
  }) as unknown as AssistantMessage

// 呼んだ役（topicId）ごとに、決めた順にツールを呼ぶモデルの代わり
function script(replies: Record<string, AssistantMessage[]>): Call {
  return async ({ topicId }) => {
    const next = replies[topicId]?.shift()
    if (!next) throw new Error(`${topicId} の応答を使い切った`)
    return next
  }
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'hyph-repo-'))
  const git = (...args: string[]) => Bun.spawnSync(['git', '-C', dir, ...args])
  git('init', '-q')
  writeFileSync(join(dir, 'test.sh'), '[ "$(cat out.txt)" = ok ]\n')
  git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  return { dir, log: () => Bun.spawnSync(['git', '-C', dir, 'log', '--format=%s', BRANCH]).stdout.toString().trim() }
}

const options = () => ({ worktrees: mkdtempSync(join(tmpdir(), 'hyph-wt-')), check: 'sh test.sh' })

test('課題を解いて検査が通ったら統合ブランチに積み、最終目的を満たしたら終える', async () => {
  const { dir, log } = repo()
  const store = createStore()
  const call = script({
    decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' }), reply('finish', { reason: '満たした' })],
    solve: [reply('write_file', { path: 'out.txt', content: 'ok' }), reply('done', { summary: '書いた' })],
  })
  await runPipeline(store, call, dir, options())
  expect(store.snapshot()).toMatchObject({ started: false, halted: '' })
  expect(store.snapshot().tasks[0]).toMatchObject({ state: 'committed', attempts: 1 })
  expect(log()).toBe('t1: out.txt に ok と書く\ninit')
})

test('検査に3回落ちたら保留にして流れを止め、統合ブランチには積まない', async () => {
  const { dir, log } = repo()
  const store = createStore()
  const wrong = () => [reply('write_file', { path: 'out.txt', content: 'ng' }), reply('done', { summary: '書いた' })]
  const call = script({
    decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' })],
    solve: [...wrong(), reply('done', { summary: 'もう一度' }), reply('done', { summary: 'もう一度' })],
  })
  await runPipeline(store, call, dir, options())
  expect(store.snapshot().tasks[0]).toMatchObject({ state: 'held', attempts: 3 })
  expect(store.snapshot().started).toBe(false)
  expect(store.snapshot().halted).toContain('保留')
  expect(log()).toBe('init')
})
