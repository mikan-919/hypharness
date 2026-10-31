import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolbox } from './tools'

const setup = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hyph-'))
  return createToolbox(new Database(':memory:'), new Database(':memory:'), dir)
}

test('ファイルは作業用ディレクトリの中だけで読み書きできる', async () => {
  const toolbox = await setup()
  await toolbox.run('file_write', { path: 'notes/a.txt', content: 'メモ' })
  expect(await toolbox.run('file_read', { path: 'notes/a.txt' })).toBe('メモ')
  expect(await toolbox.run('file_list', {})).toBe('notes/')
  await expect(toolbox.run('file_read', { path: '../x' })).rejects.toThrow()
  await expect(
    toolbox.run('file_read', { path: '/etc/passwd' }),
  ).rejects.toThrow()
})

test('共有 DB に SQL を実行し、誤りは例外になり、長い出力は切る', async () => {
  const toolbox = await setup()
  await toolbox.run('shared_db_query', { sql: 'CREATE TABLE t (v TEXT)' })
  await toolbox.run('shared_db_query', { sql: "INSERT INTO t VALUES ('x')" })
  expect(await toolbox.run('shared_db_query', { sql: 'SELECT v FROM t' })).toBe(
    '[{"v":"x"}]',
  )
  await expect(
    toolbox.run('shared_db_query', { sql: 'SELEC' }),
  ).rejects.toThrow()
  await toolbox.run('file_write', { path: 'big', content: 'a'.repeat(5000) })
  expect(await toolbox.run('file_read', { path: 'big' })).toContain(
    '5000文字のうち先頭4000文字',
  )
})
