import { expect, test } from 'bun:test'
import { openDeploy, verdict } from './deploy'
import { openLineage } from './evolve'
import { openMeasure } from './measure'

test('試験版は、確かに下回れば戻し、十分な数で下回らなければ稼働版にする', () => {
  // 結果が3件に満たないうちは決めない
  expect(verdict([1, 1, 1], [0, 0])).toBeNull()
  expect(verdict([1, 1, 1, 1], [0, 0, 0])).toBe('rollback')
  // 1件の失敗だけでは戻さない
  expect(verdict([1, 1, 1, 1], [1, 1, 0])).toBeNull()
  expect(verdict([1, 0, 1, 1], Array(10).fill(1))).toBe('promote')
})

const setup = () => {
  const m = openMeasure(':memory:')
  const lineage = openLineage(m)
  for (const commit of ['old', 'new']) {
    lineage.add({
      commit_id: commit,
      parent: null,
      description: '',
      status: 'measured',
      reason: null,
    })
  }
  m.setMeta('base', 'new')
  m.setMeta('stable', 'old')
  m.setMeta('canary', 'new')
  const deploy = openDeploy(m)
  for (let i = 0; i < 4; i++) deploy.record(i, 'old', 'stable', true, 0.01)
  return { m, lineage, deploy }
}

test('試験版が下回ったら、試験版を外し、候補を不採用にし、基準版を稼働版へ戻す', () => {
  const { m, lineage, deploy } = setup()
  expect(deploy.pick(0)).toEqual({ version: 'new', role: 'canary' })
  expect(deploy.pick(0.9)).toEqual({ version: 'old', role: 'stable' })
  for (let i = 0; i < 3; i++)
    deploy.record(10 + i, 'new', 'canary', false, 0.01)
  expect(deploy.decide()).toBe('rollback')
  expect(m.meta('canary')).toBeNull()
  expect(m.meta('base')).toBe('old')
  expect(lineage.all().find((c) => c.commit_id === 'new')?.status).toBe(
    'rejected',
  )
  expect(deploy.pick(0)).toEqual({ version: 'old', role: 'stable' })
})

test('判定のないタスクは比較に使わず、試験版が十分な数で下回らなければ稼働版にする', () => {
  const { m, deploy } = setup()
  for (let i = 0; i < 5; i++) deploy.record(20 + i, 'new', 'canary', null, 0.01)
  expect(deploy.decide()).toBeNull()
  for (let i = 0; i < 10; i++)
    deploy.record(30 + i, 'new', 'canary', true, 0.01)
  expect(deploy.decide()).toBe('promote')
  expect(m.meta('stable')).toBe('new')
  expect(m.meta('canary')).toBeNull()
})
