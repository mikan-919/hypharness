import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
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

test('コマンドは隔離環境で動き、作業用ディレクトリだけに書け、外には届かない', async () => {
  const toolbox = await setup()
  const run = (command: string) => toolbox.run('run_command', { command })
  expect(await run("echo 'console.log(1 + 1)' > a.ts && bun a.ts && pwd")).toBe(
    '終了コード 0\n2\n/work\n',
  )
  expect(await toolbox.run('file_read', { path: 'a.ts' })).toContain('1 + 1')
  expect(await run(`ls ${join(homedir(), '.hyph')}`)).not.toMatch(
    /^終了コード 0/,
  )
  expect(await run('touch /nix/store/x')).not.toMatch(/^終了コード 0/)
  expect(
    await run('bun -e \'await fetch("https://example.com")\''),
  ).not.toMatch(/^終了コード 0/)
})
