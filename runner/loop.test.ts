import { expect, test } from 'bun:test'
import { openEconomy } from './economy'
import { startLoops, turnFor } from './loop'
import type { RoleTool } from './tools'

const deps = (e: ReturnType<typeof openEconomy>) => ({
  economy: e,
  readFile: async () => null,
  agent: () => {
    throw new Error('記憶の提案は使わない')
  },
})
const use = (tools: RoleTool[], name: string, args: Record<string, unknown>) =>
  tools.find((t) => t.definition.name === name)?.run(args)

test('やることがあるときだけ turn を返し、状況が変わると key も変わる', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('目的')
  const [a] = e.companies()
  const d = deps(e)

  expect(await turnFor('market', d)).toBeNull()
  expect(await turnFor('worker-1', d)).toBeNull()
  // 設計思想が未設定なので company は動く
  const company = await turnFor(`company-${a.id}`, d)
  await use(company?.tools ?? [], 'set_philosophy', { philosophy: '速く作る' })
  for (const body of ['案1', '案2', '案3']) {
    await use(company?.tools ?? [], 'add_task', { body })
  }
  expect(await turnFor(`company-${a.id}`, d)).toBeNull()

  const before = await turnFor('worker-1', d)
  expect(before?.prompt).toContain('claim_task')
  e.sendMessage('worker-2', 'worker-1', '一緒にやろう')
  const after = await turnFor('worker-1', d)
  expect(after?.key).not.toBe(before?.key)
  after?.done?.()
  expect(e.unread('worker-1')).toEqual([])

  expect((await turnFor('investor-1', d))?.key).toBe('cycle-1')
  e.invest('investor-1', a.id, 100)
  expect(await turnFor('investor-1', d)).toBeNull()
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
        await use(tools, 'post_idea', { title: `${name}の案`, body: '本文' })
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
  const stopped = calls.length
  await Bun.sleep(50)
  expect(calls.length).toBe(stopped)
})
