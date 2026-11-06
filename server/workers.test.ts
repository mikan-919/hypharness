import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { remoteStore } from '../harness/remote.ts'
import { CostLimitError, ERROR, RESULT } from '../shared/contract.ts'
import { serveHost } from './host.ts'
import { BRANCH } from './pipeline.ts'
import { createStore } from './store.ts'
import { createWorkers } from './workers.ts'

const socketIn = (name: string) => join(mkdtempSync(join(tmpdir(), 'hyph-sock-')), name)

test('子プロセス側の対話の状態は、操作を順に届け、ask は利用者の答えを待って受け取る', async () => {
  const store = createStore()
  store.addTopic({ id: 'goal', title: '最終目的', state: 'asking', ready: false })
  const socket = socketIn('host.sock')
  const server = serveHost(store, socket)
  const remote = remoteStore(socket)
  remote.act('goal', 'tool', 'read_file')
  remote.record({ topicId: 'goal', kind: 'fact', text: '事実', evidence: '根拠' })
  expect((await remote.snapshot()).activity.map((a) => a.text)).toEqual(['read_file'])
  expect(await remote.editGoal('本文', 0, 'goal', '書いた')).toMatchObject({ ok: true, version: 1 })
  const answer = remote.ask({ topicId: 'goal', text: 'どれ？', options: [], recommendation: '', key: 'k1' })
  await Bun.sleep(100)
  expect(store.snapshot().queue).toEqual(['q1'])
  store.answer('q1', 'これ')
  expect(await answer).toBe('これ')
  await remote.flush()
  expect(store.snapshot().entries.map((e) => e.text)).toEqual(['事実'])
  server.stop(true)
}, 10_000)

// 偽の worker.ts を書く。line が最後の行になる
const worker = (dir: string, line: string) => {
  mkdirSync(join(dir, 'harness'), { recursive: true })
  writeFileSync(join(dir, 'harness', 'worker.ts'), `console.log(${JSON.stringify(line)})\n`)
}

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'hyph-harness-'))
  const git = (...args: string[]) =>
    Bun.spawnSync(['git', '-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stderr: 'pipe' })
  mkdirSync(join(dir, 'node_modules'))
  git('init', '-q')
  worker(dir, `${RESULT}"作業ツリーの版"`)
  git('add', '-A')
  git('commit', '-qm', 'init')
  return { dir, git }
}

const options = (dir: string) => ({
  harness: dir,
  versions: mkdtempSync(join(tmpdir(), 'hyph-versions-')),
  relay: '',
  host: '',
  store: createStore(),
})

test('統合ブランチがなければ作業ツリーの版で、あれば統合ブランチの先端の版で動かす', async () => {
  const { dir, git } = harness()
  const workers = createWorkers(options(dir))
  expect(await workers.run({ role: 'decompose', taskId: 't1', tree: dir })).toBe('作業ツリーの版')
  git('checkout', '-qb', BRANCH)
  worker(dir, `${RESULT}"統合ブランチの版"`)
  git('commit', '-qam', 'improve')
  git('checkout', '-q', '-')
  expect(await workers.run({ role: 'decompose', taskId: 't1', tree: dir })).toBe('統合ブランチの版')
})

test('統合ブランチの版が落ちたら、壊れた版として記録し、作業ツリーの版で動かし直す', async () => {
  const { dir, git } = harness()
  git('checkout', '-qb', BRANCH)
  writeFileSync(join(dir, 'harness', 'worker.ts'), 'throw new Error("壊れた")\n')
  git('commit', '-qam', 'broken')
  git('checkout', '-q', '-')
  const o = options(dir)
  const workers = createWorkers(o)
  expect(await workers.run({ role: 'decompose', taskId: 't1', tree: dir })).toBe('作業ツリーの版')
  expect(workers.bad.size).toBe(1)
  expect(o.store.snapshot().activity.at(-1)?.text).toContain('壊れた')
})

test('エージェントとしての誤りは、版を取り替えずにそのまま伝える', async () => {
  const { dir, git } = harness()
  git('checkout', '-qb', BRANCH)
  worker(dir, `${ERROR}${JSON.stringify({ message: '費用の上限', cost: true })}`)
  git('commit', '-qam', 'cost')
  git('checkout', '-q', '-')
  const workers = createWorkers(options(dir))
  const error = await workers.run({ role: 'decompose', taskId: 't1', tree: dir }).catch((e) => e)
  expect(error).toBeInstanceOf(CostLimitError)
  expect(workers.bad.size).toBe(0)
})
