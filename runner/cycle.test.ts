import { expect, test } from 'bun:test'
import { runCycle } from './cycle'
import { openEconomy } from './economy'
import type { RoleTool } from './tools'

test('1期で仕事の割り当て・会議・アイデア・採点・精算・投資が順に進む', async () => {
  const e = openEconomy(':memory:')
  e.setGoal('猫の写真アプリを作る')
  const calls: string[] = []
  const use = (
    tools: RoleTool[],
    name: string,
    args: Record<string, unknown>,
  ) => tools.find((t) => t.definition.name === name)?.run(args)

  await runCycle({
    economy: e,
    readFile: async () => null,
    agent: () => {
      throw new Error('提案の採用は呼ばれない')
    },
    log: () => {},
    ask: async (name, _prompt, tools) => {
      calls.push(name)
      if (name.startsWith('company-')) {
        const id = Number(name.slice('company-'.length))
        await use(tools, 'set_philosophy', { philosophy: `思想${id}` })
        for (const w of e.workersOf(id)) {
          await use(tools, 'assign_task', { worker: w, body: '案を出す' })
        }
      } else if (name.startsWith('worker-') && tools.length) {
        await use(tools, 'post_idea', { title: `${name}の案`, body: '本文' })
      } else if (name === 'market') {
        for (const i of e.ideas(1)) {
          await use(tools, 'score_idea', {
            id: i.id,
            score: 10,
            reason: '良い',
          })
        }
      } else if (name.startsWith('investor-')) {
        await use(tools, 'invest', {
          company_id: e.companies()[0].id,
          amount: 50,
        })
      }
      return '了解'
    },
  })

  // 2社 × 3人。会議で6回、仕事で6回 worker が呼ばれる
  expect(calls.filter((c) => c.startsWith('worker-'))).toHaveLength(12)
  expect(calls.slice(-3)).toEqual(['market', 'investor-1', 'investor-2'])
  expect(e.ideas(1)).toHaveLength(6)
  const [a, b] = e.companies()
  // 売上 30、配当なし（投資は精算の後）、人件費 30 → 資本 30 のまま。a には投資 100
  expect(a).toMatchObject({ philosophy: '思想1', value: 10, capital: 130 })
  expect(b).toMatchObject({ value: 10, capital: 30 })
  expect(e.latestMeetings()).toHaveLength(2)
})
