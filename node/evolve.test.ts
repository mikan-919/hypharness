import { beforeAll, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitAgent, gate } from './evolve'
import { REPO } from './measure'

// 利用者のリポジトリに参照を足さないよう、複製した上で候補を作る
let repo = ''
let head = ''
beforeAll(async () => {
  repo = join(await mkdtemp(join(tmpdir(), 'hyph-evolve-')), 'repo')
  await Bun.$`git clone -q ${REPO} ${repo}`.quiet()
  head = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()
})

// HEAD の agent/ を複製し、edit で変えた候補をコミットする
const candidate = async (edit: (agent: string) => Promise<void>) => {
  const agent = join(await mkdtemp(join(tmpdir(), 'hyph-agent-')), 'agent')
  await Bun.$`cp -a ${join(repo, 'agent')} ${agent}`.quiet()
  await edit(agent)
  return commitAgent(repo, head, agent, 'テスト用の候補')
}
const passes = async () => true

test('agent/ を変えない候補はコミットしない', async () => {
  expect(await candidate(async () => {})).toBeNull()
})

test('型検査とテストを通り、自己編集できる候補は門番を通る', async () => {
  const commit = await candidate(async (agent) => {
    await Bun.write(
      join(agent, 'note.ts'),
      'export const note: string = "ok"\n',
    )
    await Bun.write(
      join(agent, 'note.test.ts'),
      "import { expect, test } from 'bun:test'\nimport { note } from './note'\ntest('note', () => expect(note).toBe('ok'))\n",
    )
  })
  expect(commit).not.toBeNull()
  expect(await gate(repo, head, commit as string, passes)).toBeNull()
  // 自己編集の能力確認に落ちた候補は通さない
  expect(await gate(repo, head, commit as string, async () => false)).toBe(
    '改善役として agent/ を変更できませんでした',
  )
}, 120_000)

test('型検査を壊す候補は通さない', async () => {
  const commit = await candidate(async (agent) => {
    await Bun.write(join(agent, 'broken.ts'), 'export const n: number = "x"\n')
  })
  expect(await gate(repo, head, commit as string, passes)).toStartWith(
    '型検査に失敗しました',
  )
}, 120_000)

test('テストを壊す候補は通さない', async () => {
  const commit = await candidate(async (agent) => {
    await Bun.write(
      join(agent, 'bad.test.ts'),
      "import { expect, test } from 'bun:test'\ntest('bad', () => expect(1).toBe(2))\n",
    )
  })
  expect(await gate(repo, head, commit as string, passes)).toStartWith(
    'agent/ のテストに失敗しました',
  )
}, 120_000)

test('進化対象の外の変更はコミットに入らず、外を変えたコミットは通さない', async () => {
  // 作業用ディレクトリの agent/ の外に置いたファイルは、commitAgent が拾わない
  const root = await mkdtemp(join(tmpdir(), 'hyph-outside-'))
  await Bun.$`cp -a ${join(repo, 'agent')} ${join(root, 'agent')}`.quiet()
  await Bun.write(join(root, 'agent', 'x.ts'), 'export const x = 1\n')
  await Bun.write(join(root, 'node', 'measure.ts'), 'export {}\n')
  const commit = (await commitAgent(
    repo,
    head,
    join(root, 'agent'),
    '外も変える候補',
  )) as string
  expect(
    (
      await Bun.$`git -C ${repo} diff --name-only ${head} ${commit}`.text()
    ).trim(),
  ).toBe('agent/x.ts')
  // 別の経路で外を変えたコミットが来ても、門番が止める
  await Bun.write(join(repo, 'node', 'measure.ts'), 'export {}\n')
  await Bun.$`git -C ${repo} commit -qam 外を変える`.quiet()
  const outside = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()
  expect(await gate(repo, head, outside, passes)).toBe(
    '進化対象の外を変更しています: node/measure.ts',
  )
}, 120_000)
