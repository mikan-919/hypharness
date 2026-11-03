import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { LEASE_MS, openQueue, type Sql } from './queue'

const V = 'a'.repeat(40)
const done = { code: 0, ok: null, version: V }

const setup = () => {
  const db = new Database(':memory:', { strict: true })
  const sql: Sql = (query, ...params) =>
    db.query(query).all(...params) as never[]
  return openQueue(sql)
}

test('入れたタスクを1つのノードに割り当て、完了の報告を受け付ける', () => {
  const q = setup()
  const id = q.add('課題', 'true', 0)
  const grant = q.claim('a', 1)
  expect(grant).toEqual({
    id,
    statement: '課題',
    check: 'true',
    generation: 1,
  })
  // 実行中のノードと、待ち行列が空のときは割り当てない
  expect(q.claim('a', 2)).toBeNull()
  expect(q.claim('b', 2)).toBeNull()
  expect(q.finish(id, 1, 'a', { code: 0, ok: true, version: V }, 3)).toBe(true)
  expect(q.tasks()[0]).toMatchObject({
    state: 'done',
    code: 0,
    ok: 1,
    version: V,
  })
  expect(q.history(id).map((e) => e.kind)).toEqual(['queued', 'leased', 'done'])
})

test('更新の止まった実行権は期限の後に待ち行列へ戻り、別のノードに割り当てる', () => {
  const q = setup()
  const id = q.add('課題', null, 0)
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
  const id = q.add('課題', null, 0)
  q.claim('a', 0)
  // a が止まっている間に回収され、b が新しい世代で持つ
  q.claim('b', LEASE_MS)
  expect(q.renew(id, 1, 'a', LEASE_MS + 1)).toBe(false)
  expect(q.finish(id, 1, 'a', done, LEASE_MS + 1)).toBe(false)
  expect(q.finish(id, 2, 'a', done, LEASE_MS + 1)).toBe(false)
  expect(q.tasks()[0]).toMatchObject({ state: 'leased', node: 'b' })
  expect(q.finish(id, 2, 'b', done, 3 * LEASE_MS)).toBe(false)
  expect(q.history(id).at(-1)).toMatchObject({ kind: 'rejected', node: 'b' })
})

test('次に期限が来る実行権の時刻を返す', () => {
  const q = setup()
  expect(q.nextExpiry()).toBeNull()
  q.add('課題', null, 0)
  q.claim('a', 10)
  expect(q.nextExpiry()).toBe(10 + LEASE_MS)
})

test('段階3より前の表（command の列）を、課題文と判定コマンドの表に移す', () => {
  const db = new Database(':memory:', { strict: true })
  db.run(
    "CREATE TABLE tasks (id INTEGER PRIMARY KEY, command TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', node TEXT, generation INTEGER NOT NULL DEFAULT 0, expires INTEGER, code INTEGER, created_at INTEGER NOT NULL)",
  )
  db.run("INSERT INTO tasks (command, created_at) VALUES ('echo hi', 0)")
  const q = openQueue(
    (query, ...params) => db.query(query).all(...params) as never[],
  )
  expect(q.tasks()[0]).toMatchObject({
    statement: 'echo hi',
    check_command: null,
    ok: null,
  })
})
