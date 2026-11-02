import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { LEASE_MS, openQueue, type Sql } from './queue'

const setup = () => {
  const db = new Database(':memory:', { strict: true })
  const sql: Sql = (query, ...params) =>
    db.query(query).all(...params) as never[]
  return openQueue(sql)
}

test('入れたタスクを1つのノードに割り当て、完了の報告を受け付ける', () => {
  const q = setup()
  const id = q.add('echo hi', 0)
  const grant = q.claim('a', 1)
  expect(grant).toEqual({ id, command: 'echo hi', generation: 1 })
  // 実行中のノードと、待ち行列が空のときは割り当てない
  expect(q.claim('a', 2)).toBeNull()
  expect(q.claim('b', 2)).toBeNull()
  expect(q.finish(id, 1, 'a', 0, 3)).toBe(true)
  expect(q.tasks()[0]).toMatchObject({ state: 'done', code: 0 })
  expect(q.history(id).map((e) => e.kind)).toEqual(['queued', 'leased', 'done'])
})

test('更新の止まった実行権は期限の後に待ち行列へ戻り、別のノードに割り当てる', () => {
  const q = setup()
  const id = q.add('sleep 100', 0)
  q.claim('a', 0)
  expect(q.renew(id, 1, 'a', LEASE_MS - 1)).toBe(true)
  // 更新で期限が延びるため、最初の期限ではまだ回収しない
  q.reclaim(LEASE_MS)
  expect(q.tasks()[0].state).toBe('leased')
  q.reclaim(2 * LEASE_MS)
  expect(q.tasks()[0]).toMatchObject({ state: 'queued', node: null })
  expect(q.claim('b', 2 * LEASE_MS)).toMatchObject({ id, generation: 2 })
  expect(q.history(id).map((e) => e.kind)).toEqual([
    'queued',
    'leased',
    'expired',
    'leased',
  ])
})

test('古い世代・別のノード・期限切れの実行権からの報告は受け付けない', () => {
  const q = setup()
  const id = q.add('true', 0)
  q.claim('a', 0)
  // a が止まっている間に回収され、b が新しい世代で持つ
  q.claim('b', LEASE_MS)
  expect(q.renew(id, 1, 'a', LEASE_MS + 1)).toBe(false)
  expect(q.finish(id, 1, 'a', 0, LEASE_MS + 1)).toBe(false)
  expect(q.finish(id, 2, 'a', 0, LEASE_MS + 1)).toBe(false)
  expect(q.tasks()[0]).toMatchObject({ state: 'leased', node: 'b' })
  expect(q.finish(id, 2, 'b', 1, 3 * LEASE_MS)).toBe(false)
  expect(q.history(id).at(-1)).toMatchObject({ kind: 'rejected', node: 'b' })
})

test('次に期限が来る実行権の時刻を返す', () => {
  const q = setup()
  expect(q.nextExpiry()).toBeNull()
  q.add('true', 0)
  q.claim('a', 10)
  expect(q.nextExpiry()).toBe(10 + LEASE_MS)
})
