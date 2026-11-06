import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Message } from '@earendil-works/pi-ai'
import { BRANCH, runPipeline } from './pipeline.ts'
import { createStore } from './store.ts'
import { CostLimitError } from './topic.ts'
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

type Call0 = { taskId: string; system: string }

// 解答役に渡したシステムプロンプトを、課題 id と組にして集める
function recorded(replies: Record<string, AssistantMessage[]>, prompts: Call0[]): Call {
  const inner = script(replies)
  return async (body) => {
    if (body.topicId === 'solve') prompts.push({ taskId: body.taskId, system: body.context.systemPrompt })
    return inner(body)
  }
}

const systems = (prompts: Call0[], taskId: string) => prompts.filter((p) => p.taskId === taskId).map((p) => p.system)

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

test('積んだ課題の記録に差分を残し、保留にした課題の差分は空のままにする', async () => {
  const { dir } = repo()
  const store = createStore()
  const wrong = () => [reply('write_file', { path: 'out.txt', content: 'ng' }), reply('done', { summary: '書いた' })]
  // 検査に落ちて保留になった課題
  await runPipeline(
    store,
    script({
      decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' })],
      solve: [...wrong(), reply('done', { summary: 'もう一度' }), reply('done', { summary: 'もう一度' })],
    }),
    dir,
    options(),
  )
  expect(store.snapshot().tasks[0]).toMatchObject({ state: 'held', diff: '' })

  // 検査が通って積んだ課題
  await runPipeline(
    store,
    script({
      decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' }), reply('finish', { reason: '満たした' })],
      solve: [reply('write_file', { path: 'out.txt', content: 'ok' }), reply('done', { summary: '書いた' })],
    }),
    dir,
    options(),
  )
  const committed = store.snapshot().tasks[1]
  expect(committed.state).toBe('committed')
  expect(committed.diff.split('\n')).toContain('+ok')
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
  expect(store.snapshot().tasks[0].reason).not.toBe('')
  expect(store.snapshot().tasks[0].reason).toContain('検査が終了コード')
  expect(typeof store.snapshot().tasks[0].spent).toBe('number')
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

test('費用の上限で断られたら課題を保留にして流れを止め、統合ブランチには積まない', async () => {
  const { dir, log } = repo()
  const store = createStore()
  // 分解役は課題を1つ出し、解答役のモデルの呼び出しは中継に断られる
  const call: Call = async ({ topicId }) => {
    if (topicId === 'decompose') return reply('submit_task', { statement: 'out.txt に ok と書く' })
    throw new CostLimitError('停止中です: 課題 t1 が費用の上限 1 に達しました')
  }
  await runPipeline(store, call, dir, { ...options(), spent: (taskId) => (taskId === 't1' ? 1.2 : 0), limitUsd: 1 })
  expect(store.snapshot().tasks[0]).toMatchObject({ state: 'held' })
  expect(store.snapshot().tasks[0].reason).toContain('停止中です: 課題 t1 が費用の上限 1 に達しました')
  expect(store.snapshot().tasks[0].spent).toBe(1.2)
  expect(store.snapshot().started).toBe(false)
  expect(store.snapshot().halted).toContain('t1')
  expect(store.snapshot().halted).toContain('1.2')
  expect(store.snapshot().halted).toContain('上限 1')
  expect(log()).toBe('init')
})

test('分解役に保留にした課題とその理由と保留の割合を渡す', async () => {
  const { dir } = repo()
  const store = createStore()
  const id = store.addTask('out.txt に ok と書く\n詳しい説明')
  store.setTask(id, { state: 'held', reason: '検査が終了コード 1 で落ちました\n出力の続き' })
  let messages: Message[] = []
  const call: Call = async ({ topicId, context }) => {
    if (topicId !== 'decompose') throw new Error('分解役以外は呼ばない')
    messages = context.messages
    return reply('finish', { reason: '満たした' })
  }
  await runPipeline(store, call, dir, options())
  const user = messages.find((m) => m.role === 'user')
  const text = String(user?.content)
  expect(text).toContain(id)
  expect(text).toContain('out.txt に ok と書く')
  expect(text).toContain('検査が終了コード 1 で落ちました')
  expect(text).toContain('保留 1 / 課題 1')
})

test('解答役のシステムプロンプトに、根拠が実行の結果の経験だけを新しい順に入れる', async () => {
  // 検査に落ちて保留になった課題の失敗が、次に解く課題のシステムプロンプトに入る
  const { dir } = repo()
  const store = createStore()
  // 論点エージェントが書いた項目は、根拠が実行の結果でないので入れない
  store.record({ topicId: 'k1', kind: 'fact', text: '利用者は赤を選んだ', evidence: '利用者の答え' })
  const wrong = () => [reply('write_file', { path: 'out.txt', content: 'ng' }), reply('done', { summary: '書いた' })]
  const first: Call0[] = []
  await runPipeline(
    store,
    recorded(
      {
        decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' })],
        solve: [...wrong(), reply('done', { summary: 'もう一度' }), reply('done', { summary: 'もう一度' })],
      },
      first,
    ),
    dir,
    options(),
  )
  expect(store.snapshot().tasks[0]).toMatchObject({ state: 'held' })
  expect(store.snapshot().entries.filter((e) => e.kind === 'fail')).toHaveLength(3)
  const second: Call0[] = []
  await runPipeline(
    store,
    recorded(
      {
        decompose: [reply('submit_task', { statement: 'out.txt に ok と書く' }), reply('finish', { reason: '満たした' })],
        solve: [reply('write_file', { path: 'out.txt', content: 'ok' }), reply('done', { summary: '直した' })],
      },
      second,
    ),
    dir,
    options(),
  )
  // 2つ目の課題を解く解答役の呼び出し
  const next = systems(second, 't2')
  expect(next.length).toBeGreaterThan(0)
  for (const system of next) {
    expect(system).toContain('検査が終了コード 1 で落ちました')
    expect(system).toContain('課題 t1 の検査の終了コード 1')
    expect(system).not.toContain('利用者は赤を選んだ')
    expect(system).not.toContain('利用者の答え')
  }

  // 積んだ課題の事実の項目（課題文の1行目、変えた点、積んだコミットの短い id）が入る
  const committed = repo()
  const other = createStore()
  other.record({ topicId: 'k1', kind: 'fact', text: '利用者は赤を選んだ', evidence: '利用者の答え' })
  const prompts: Call0[] = []
  await runPipeline(
    other,
    recorded(
      {
        decompose: [
          reply('submit_task', { statement: 'out.txt に ok と書く\n詳しい説明' }),
          reply('submit_task', { statement: 'note.txt を足す' }),
          reply('finish', { reason: '満たした' }),
        ],
        solve: [
          reply('write_file', { path: 'out.txt', content: 'ok' }),
          reply('done', { summary: 'out.txt を書いた' }),
          reply('write_file', { path: 'note.txt', content: 'n' }),
          reply('done', { summary: 'note.txt を足した' }),
        ],
      },
      prompts,
    ),
    committed.dir,
    options(),
  )
  expect(other.snapshot().tasks[0].state).toBe('committed')
  const commit = other.snapshot().tasks[0].commit.slice(0, 8)
  // 項目がないときは節を出さない
  for (const system of systems(prompts, 't1')) expect(system).not.toContain('共有文脈から作った経験の一覧')
  // 2つ目の課題を解く解答役の呼び出し
  const later = systems(prompts, 't2')
  expect(later.length).toBeGreaterThan(0)
  for (const system of later) {
    expect(system).toContain('共有文脈から作った経験の一覧')
    expect(system).toContain('out.txt に ok と書く')
    expect(system).toContain('変えた点: out.txt を書いた')
    expect(system).toContain(`課題 t1 のコミット ${commit}`)
    expect(system).not.toContain('利用者は赤を選んだ')
  }
})
