import { beforeAll, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ArmStats, commitAgent, compare, gate, rate, ucb } from './evolve'
import { openMeasure, REPO } from './measure'

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

test('UCB1 は試していない改善対象を先に選び、その後は勝率と試行の少なさで選ぶ', () => {
  expect(ucb([])).toBe('prompt')
  expect(ucb([{ arm: 'prompt', n: 1, wins: 0 }])).toBe('module')
  const tried = (wins: [number, number, number]): ArmStats[] => [
    { arm: 'prompt', n: 10, wins: wins[0] },
    { arm: 'module', n: 10, wins: wins[1] },
    { arm: 'code', n: 10, wins: wins[2] },
  ]
  expect(ucb(tried([1, 8, 2]))).toBe('module')
  // 勝率が同程度なら、試行の少ない対象を選ぶ
  expect(
    ucb([
      { arm: 'prompt', n: 20, wins: 10 },
      { arm: 'module', n: 2, wins: 1 },
      { arm: 'code', n: 20, wins: 10 },
    ]),
  ).toBe('module')
})

test('変更行数が上限を超える候補は通さない', async () => {
  const commit = await candidate(async (agent) => {
    await Bun.write(
      join(agent, 'long.ts'),
      Array.from({ length: 30 }, (_, i) => `export const v${i} = ${i}\n`).join(
        '',
      ),
    )
  })
  expect(await gate(repo, head, commit as string, passes, 20)).toBe(
    '変更が 30 行で、上限の 20 行を超えています',
  )
}, 120_000)

test('繰り返し測った版の成功率は、最新の1回ではなく平均で返す', () => {
  const m = openMeasure(':memory:')
  const task = {
    statement: 's',
    files: {},
    check: 'true',
    check_files: {},
    solution: {},
  }
  for (let i = 0; i < 3; i++) m.addTask(task, 'val')
  const now = m.conditions('val')
  // 最後の1件は、解答役の推論の深さが違う条件で測ったもの。比べる計測には入れない
  for (const [ok, conditions] of [
    [1, now],
    [1, now],
    [0, now],
    [3, `${now}x`],
  ]) {
    m.db.run(
      "INSERT INTO measurements (commit_id, split, ok, total, started_at, conditions) VALUES ('c', 'val', ?, 3, 0, ?)",
      [ok, conditions],
    )
  }
  expect(rate(m, 'c', 'val')).toBeCloseTo(2 / 9)
  expect(rate(m, 'none', 'val')).toBeNull()
})

test('成功率の差は、課題数と計測回数から求めたばらつきの2倍を超えたときだけ偶然でないとみなす', () => {
  // 8問で 0.542 と 0.75 を各3回: 差 0.208 は基準 0.269 に届かない
  const few = compare([0.5, 0.625, 0.5], [0.75, 0.75, 0.75], 8)
  expect(few.delta).toBeCloseTo(0.208, 3)
  expect(few.delta).toBeLessThan(few.margin)
  // 同じ差でも計測回数を増やせば基準を超える
  const many = compare(Array(10).fill(0.542), Array(10).fill(0.75), 8)
  expect(many.delta).toBeGreaterThan(many.margin)
})
