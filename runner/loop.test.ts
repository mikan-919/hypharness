import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { openContexts } from './context'
import { openEconomy } from './economy'
import { startLoops, turnFor } from './loop'
import type { RoleTool } from './tools'

// エージェントごとに固有 DB を1つ持たせる
const deps = (e: ReturnType<typeof openEconomy>) => {
  const dbs = new Map<string, Database>()
  return {
    economy: e,
    contexts: openContexts(e.db),
    readFile: async () => null,
    agent: (name: string) => {
      const db = dbs.get(name) ?? new Database(':memory:')
      dbs.set(name, db)
      return { agent: { db } as never }
    },
  }
}
const use = (tools: RoleTool[], name: string, args: Record<string, unknown>) =>
  tools.find((t) => t.definition.name === name)?.run(args)

test('やることがあるときだけ turn を返し、状況が変わると key も変わる', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  const [a] = e.companies()
  const d = deps(e)

  expect(await turnFor('market', d)).toBeNull()
  expect(await turnFor('worker-1', d)).toBeNull()
  const [, b] = e.companies()
  // 設計思想は id の小さい会社から順に決める。後の会社は先に決まった思想を見て選ぶ
  expect(await turnFor(`company-${b.id}`, d)).toBeNull()
  // 設計思想が未設定なので company は動く
  const company = await turnFor(`company-${a.id}`, d)
  await use(company?.tools ?? [], 'set_philosophy', { philosophy: '速く作る' })
  for (const body of ['案1', '案2', '案3']) {
    await use(company?.tools ?? [], 'add_task', { body })
  }
  expect(await turnFor(`company-${a.id}`, d)).toBeNull()
  expect((await turnFor(`company-${b.id}`, d))?.prompt).toContain(
    '設計思想: 速く作る',
  )

  const before = await turnFor('worker-1', d)
  expect(before?.prompt).toContain('claim_task')
  e.sendMessage('worker-2', 'worker-1', '一緒にやろう')
  const after = await turnFor('worker-1', d)
  expect(after?.key).not.toBe(before?.key)
  after?.done?.()
  expect(e.unread('worker-1')).toEqual([])

  // investor は最初の精算までは動かない
  expect(await turnFor('investor-1', d)).toBeNull()
  e.db.query('UPDATE companies SET capital = 200').run()
  e.settle()
  expect((await turnFor('investor-1', d))?.key).toBe('cycle-2')
})

test('各エージェントが自分のループで動き、精算で期が進み、止められる', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  const calls: string[] = []
  const loops = startLoops({
    ...deps(e),
    log: () => {},
    idleMs: 5,
    settleMs: 300,
    ask: async (name, _prompt, tools) => {
      calls.push(name)
      if (name.startsWith('company-')) {
        await use(tools, 'set_philosophy', { philosophy: '速く作る' })
        const id = Number(name.slice('company-'.length))
        for (const _ of e.workersOf(id)) {
          await use(tools, 'add_task', { body: '案を出す' })
        }
      } else if (name.startsWith('worker-')) {
        const task = e.openTask(name)
        if (!task) {
          const [first] = e.pool(e.workerCompany(name) ?? -1)
          if (first) await use(tools, 'claim_task', { id: first.id })
          return '引き受けた'
        }
        const add = async (raw: string) =>
          String(
            await use(tools, 'context_add', {
              scope: 'shared',
              gist: `${name}の要点`,
              summary: '- 「猫の写真を整理する」',
              raw,
            }),
          ).split(' ')[0]
        const post = (entry: string) =>
          use(tools, 'post_idea', { title: `${name}の案`, body: '本文', entry })
        await post(
          await add('猫の写真を整理する。近い研究 https://example.com/a'),
        )
        // 先行研究の URL が無いエントリーや、無いエントリーは受け付けない
        await expect(post(await add('猫の写真を整理する'))).rejects.toThrow(
          'URL',
        )
        await expect(post('S999')).rejects.toThrow()
        await use(tools, 'finish_task', { result: '終えた' })
      } else if (name === 'market') {
        for (const i of e.unscoredIdeas()) {
          await use(tools, 'score_idea', { id: i.id, score: 9, reason: '良い' })
        }
      } else if (name.startsWith('investor-')) {
        await use(tools, 'invest', {
          company_id: e.companies()[0].id,
          amount: 10,
        })
      }
      return '了解'
    },
  })
  await Bun.sleep(700)
  await loops.stop()

  expect(e.cycle()).toBeGreaterThanOrEqual(2)
  expect(e.latestIdeas().length).toBeGreaterThan(0)
  expect(e.unscoredIdeas()).toEqual([])
  expect(e.stakesOf('investor-1').length).toBeGreaterThan(0)
  // 状況が変わらないあいだは呼び直さない（期ごとに1回）
  const investorCalls = calls.filter((c) => c === 'investor-1').length
  expect(investorCalls).toBeLessThanOrEqual(e.cycle())
  // 止めたあとも、各エージェントがどこまで進んだかが残る
  const activity = loops.activity()
  expect(activity.every((x) => x.state === '停止')).toBe(true)
  expect(activity.find((x) => x.name === 'market')?.detail).toContain(
    '未採点のアイデア',
  )
  const stopped = calls.length
  await Bun.sleep(50)
  expect(calls.length).toBe(stopped)
})

test('全員のプロンプトに2層のコンテキストが入り、受け取ったエントリーで worker が動く', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  const d = deps(e)
  expect(await turnFor('worker-1', d)).toBeNull()

  // worker-2 が自分用のエントリーを作って worker-1 に渡す
  e.sendMessage('worker-1', 'worker-2', '起きて')
  const turn = await turnFor('worker-2', d)
  expect(turn?.prompt).toContain('共有コンテキスト')
  expect(turn?.prompt).toContain('自分用コンテキスト')
  await use(turn?.tools ?? [], 'context_add', {
    scope: 'own',
    gist: '要点',
    summary: '- 「猫の写真を整理する」',
    raw: '猫の写真を整理する',
  })
  await use(turn?.tools ?? [], 'give_context', { to: 'worker-1', label: 'O1' })
  expect(() =>
    use(turn?.tools ?? [], 'give_context', { to: 'investor-1', label: 'O1' }),
  ).toThrow()

  const received = await turnFor('worker-1', d)
  expect(received?.prompt).toContain('worker-2 から）: 要点')
})

test('精算の時刻は DB に残り、止めている間に過ぎていれば再開した直後に精算する', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  const run = () =>
    startLoops({
      ...deps(e),
      log: () => {},
      idleMs: 5,
      settleMs: 60_000,
      ask: async () => '了解',
    })
  await run().stop()
  expect(e.nextSettleAt()).toBeGreaterThan(Date.now())
  e.setNextSettleAt(Date.now() - 1)
  const loops = run()
  await Bun.sleep(30)
  await loops.stop()
  expect(e.cycle()).toBe(2)
})
