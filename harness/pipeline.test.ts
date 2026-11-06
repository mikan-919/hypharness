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
    decompose: [reply('submit_task', { statement: 'out.txt に ok と書く。理由は検査のため\n\n## 受け入れの条件\n- test.sh が通る' }), reply('finish', { reason: '満たした' })],
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

test('解いている間に統合ブランチが動いていたら、上書きせずに流れを止める', async () => {
  const { dir, log } = repo()
  const store = createStore()
  const call = script({
    decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' })],
    solve: [
      reply('write_file', { path: 'out.txt', content: 'ok' }),
      reply('done', { summary: '書いた' }),
    ],
  })
  const moving: Call = async (body) => {
    // 解答役が終える直前に、別の誰かが統合ブランチにコミットを積む
    if (body.topicId === 'solve' && body.context.messages.length > 2) {
      Bun.spawnSync(['git', '-C', dir, 'commit', '--allow-empty', '-qm', 'outside'], {
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      })
      Bun.spawnSync(['git', '-C', dir, 'branch', '-f', BRANCH, 'HEAD'])
    }
    return call(body)
  }
  await runPipeline(store, moving, dir, options())
  expect(store.snapshot().started).toBe(false)
  expect(store.snapshot().halted).not.toBe('')
  expect(log()).toBe('outside\ninit')
})

test('分解役に画面の最終目的を渡し、その本文を最初の課題のコミットに入れる', async () => {
  const { dir } = repo()
  const store = createStore()
  store.editGoal('out.txt に ok と書く', 0, 'user', '最初')
  const seen: string[] = []
  const inner = script({
    decompose: [reply('submit_task', { title: 'ok を書く', statement: 'out.txt に ok と書く' }), reply('finish', { reason: '満たした' })],
    solve: [reply('write_file', { path: 'out.txt', content: 'ok' }), reply('done', { summary: '書いた' })],
  })
  const call: Call = async (body) => {
    if (body.topicId === 'decompose') seen.push(JSON.stringify(body.context.messages[0]))
    return inner(body)
  }
  await runPipeline(store, call, dir, options())
  expect(seen[0]).toContain('out.txt に ok と書く')
  const subject = Bun.spawnSync(['git', '-C', dir, 'log', '-1', '--format=%s', BRANCH]).stdout.toString().trim()
  expect(subject).toBe('t1: ok を書く')
  expect(Bun.spawnSync(['git', '-C', dir, 'show', `${BRANCH}:FINAL_GOAL.md`]).stdout.toString()).toBe('out.txt に ok と書く')
})

test('止めるボタンを押したら、今の課題を終えてから次の課題に入らずに止める', async () => {
  const { dir, log } = repo()
  const store = createStore()
  const inner = script({
    decompose: [reply('submit_task', { title: 'ok を書く', statement: 'out.txt に ok と書く' })],
    solve: [reply('write_file', { path: 'out.txt', content: 'ok' }), reply('done', { summary: '書いた' })],
  })
  const call: Call = async (body) => {
    // 解答役が解いている途中で、利用者が止めるボタンを押す
    if (body.topicId === 'solve') store.setRun({ stopping: true })
    return inner(body)
  }
  await runPipeline(store, call, dir, options())
  expect(store.snapshot()).toMatchObject({ started: false, halted: '利用者が止めました', stopping: false })
  expect(log()).toBe('t1: ok を書く\ninit')
})
