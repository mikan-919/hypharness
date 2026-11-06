// RSI のループを自動で回す。初回は作業領域・最終目的・課題を用意し、その後は期の予算があるかぎり
// 改良（evolve）→ 採用（promote）を繰り返す。採用された版はノードが次のタスクから試験版として使う。
// 予算を使い切ったら次の期（UTC の翌日）まで待つ。
// 使い方: bun run auto <セッション> <リポジトリ> <最終目的のファイル> <1日の予算ドル> [読み取り専用で見せるディレクトリ...]
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { openLineage, promote, rounds } from './evolve'
import { openLedger, periodOf } from './ledger'
import { DIR, mine, models, openMeasure, REPO } from './measure'

// ponytail: 1回のループの周回数・測り直す候補の数と回数・課題の数は、これまでの手動の運用の値。
// 採用の頻度と費用を見て変える
const ROUNDS = 6
const TOP = 3
const REPEATS = 3
const VAL_TASKS = 27
const TEST_TASKS = 10
const MINE_LINES = 400

const [session = '', repo = '', goalFile = '', dollars = '', ...mounts] =
  process.argv.slice(2)
if (
  !/^[\w-]{1,32}$/.test(session) ||
  !repo ||
  !goalFile ||
  !(Number(dollars) > 0)
) {
  throw new Error(
    '使い方: bun run auto <セッション> <リポジトリ> <最終目的のファイル> <1日の予算ドル> [読み取り専用で見せるディレクトリ...]',
  )
}
await Bun.$`git -C ${repo} rev-parse HEAD`.quiet()
for (const p of mounts) if (!existsSync(p)) throw new Error(`${p} がありません`)
await mkdir(join(DIR, 'sessions'), { recursive: true, mode: 0o700 })
const m = openMeasure(join(DIR, 'sessions', `${session}.sqlite`))
const ledger = openLedger(m)
// 予算の上限なしで回し続けないよう、1日の総予算を必ず決める
m.setMeta('budget:period', String(Number(dollars)))
const self = await models((cost) => ledger.record('self', cost))
const verify = await models((cost) => ledger.record('verify', cost))

// 作業領域。開発環境の設定は、リポジトリの nix の開発環境から作る
if (!m.meta('workspace')) {
  const prelude = join(DIR, 'sessions', `${session}.env.sh`)
  await Bun.write(
    prelude,
    await Bun.$`nix print-dev-env ${resolve(repo)}`.text(),
  )
  m.setMeta(
    'workspace',
    JSON.stringify({
      repo: resolve(repo),
      prelude,
      mounts: mounts.map((p) => resolve(p)),
    }),
  )
  console.log(`作業領域: ${resolve(repo)}`)
}
const goal = await Bun.file(goalFile).text()
const saved = m.meta('goal')
if (saved !== null && saved !== goal) {
  throw new Error(
    'このセッションは別の最終目的で作られています。別のセッション名を使ってください',
  )
}
m.setMeta('goal', goal)
// 課題。足りない分を作業領域の過去のコミットから作る
const missing = (split: 'val' | 'test', want: number) =>
  Math.max(0, want - m.tasks(split).length)
if (missing('val', VAL_TASKS) || missing('test', TEST_TASKS)) {
  await mine(
    m,
    verify.generator,
    missing('val', VAL_TASKS),
    missing('test', TEST_TASKS),
    MINE_LINES,
  )
}
if (!m.tasks('val').length || !m.tasks('test').length) {
  throw new Error('課題を作れませんでした')
}

const start = (await Bun.$`git -C ${REPO} rev-parse HEAD`.text()).trim()
const exhausted = () => ledger.remaining('self') <= 0
for (let cycle = 1; ; cycle++) {
  if (exhausted()) {
    const next = Date.parse(`${periodOf()}T00:00:00Z`) + 24 * 60 * 60 * 1000
    console.log(
      `今期の自己改善の予算を使い切りました。${new Date(next).toISOString()} まで待ちます`,
    )
    await Bun.sleep(next - Date.now())
    continue
  }
  console.log(`--- ループ ${cycle}（${new Date().toISOString()}）`)
  await rounds(
    m,
    start,
    ROUNDS,
    self.solver,
    self.generator,
    'explore',
    exhausted,
  )
  if (exhausted()) continue
  const adopted = await promote(m, self.solver, TOP, REPEATS)
  if (adopted) ledger.improved('self', adopted.delta, adopted.commit)
  const lineage = openLineage(m).pool()
  console.log(
    `ループ ${cycle} 終了: 候補 ${lineage.length} 件、基準版 ${m.meta('base')?.slice(0, 7)}、今期の残り $${ledger.remaining('self').toFixed(2)}`,
  )
}
