// RSI のループを自動で回す。初回は作業領域・最終目的・課題を用意し、その後は期の予算があるかぎり
// 改良（evolve）→ 採用（promote）を繰り返す。採用された版はノードが次のタスクから試験版として使う。
// 予算を使い切ったら次の期（UTC の翌日）まで待つ。
// 使い方: bun run auto <セッション> <リポジトリ> <最終目的のファイル> <1日の予算ドル> [読み取り専用で見せるディレクトリ...]
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { counts, openLineage, promote, rounds } from './evolve'
import { openLedger, periodOf } from './ledger'
import { budgetKey, DIR, mine, models, openMeasure, REPO } from './measure'

// ponytail: 1回のループの周回数・測り直す候補の数と回数・課題の数は、これまでの手動の運用の値。
// 採用の頻度と費用を見て変える
const ROUNDS = 6
const TOP = 3
const REPEATS = 3
const VAL_TASKS = 27
const TEST_TASKS = 10
const MINE_LINES = 400
// ponytail: 課題を作り直すのは、最も新しい課題のコミットから main が10コミット以上進んだとき。
// 作り直すと課題の組が変わり、基準版を測り直すため、コミットのたびには作り直さない。開発の速さを見て変える
const REFRESH_COMMITS = 10

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

// 作業領域は、リポジトリの origin を複製した専用のディレクトリにする。利用者の作業ツリーには触れず、
// ループのたびに origin の既定のブランチの最新に合わせる（マージされた PR を課題とタスクに取り込む）
const clone = join(DIR, 'repos', session)
if (!existsSync(join(clone, '.git'))) {
  const origin = (
    await Bun.$`git -C ${repo} remote get-url origin`.text()
  ).trim()
  await mkdir(join(DIR, 'repos'), { recursive: true, mode: 0o700 })
  await Bun.$`git clone -q ${origin} ${clone}`.quiet()
}
const sync = async () => {
  await Bun.$`git -C ${clone} fetch -q origin`.quiet()
  await Bun.$`git -C ${clone} reset -q --hard origin/HEAD`.quiet()
  return (await Bun.$`git -C ${clone} rev-parse HEAD`.text()).trim()
}
await sync()
if (!m.meta('workspace')) {
  // 開発環境の設定は、リポジトリの nix の開発環境から作る
  const prelude = join(DIR, 'sessions', `${session}.env.sh`)
  await Bun.write(prelude, await Bun.$`nix print-dev-env ${clone}`.text())
  m.setMeta(
    'workspace',
    JSON.stringify({
      repo: clone,
      prelude,
      mounts: mounts.map((p) => resolve(p)),
    }),
  )
  console.log(`作業領域: ${clone}`)
}
const goal = await Bun.file(goalFile).text()
const saved = m.meta('goal')
if (saved !== null && saved !== goal) {
  throw new Error(
    'このセッションは別の最終目的で作られています。別のセッション名を使ってください',
  )
}
m.setMeta('goal', goal)
// 課題。main が課題のコミットから REFRESH_COMMITS 以上進んでいたら、今の課題を外して最新の履歴から作り直す。
// 足りない分は作業領域の過去のコミットから作る
// 課題を外す。外した課題の計測は残す。課題の組が変わると計測の条件も変わり、基準版と予算の基準はこのモデルで測り直す
const retire = (ids: number[]) => {
  if (!ids.length) return
  m.db.run(
    `UPDATE tasks SET split = 'retired' WHERE split IN ('val', 'test') AND id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )
  m.db.run('DELETE FROM meta WHERE key IN (?, ?)', [
    budgetKey('val'),
    budgetKey('test'),
  ])
}
// 基準版が測り直したすべての回で解いた課題は、候補の差を見分けられないため外す。外した分は次のループで最新の履歴から作る
const retireSolved = () => {
  const base = m.meta('base')
  if (!base) return
  const solved = (['val', 'test'] as const).flatMap((split) =>
    [...counts(m, base, split)]
      .filter(([, c]) => c.n >= REPEATS && c.ok === c.n)
      .map(([task]) => task),
  )
  if (solved.length) {
    console.log(
      `基準版が毎回解いた課題 ${solved.length} 件を外し、次のループで最新の履歴から作り直します`,
    )
    retire(solved)
  }
}
const refresh = async (head: string) => {
  const commits = [...m.tasks('val'), ...m.tasks('test')]
    .map((t) => t.workspace?.commit)
    .filter((c): c is string => Boolean(c))
  const behind = commits.length
    ? Math.min(
        ...(await Promise.all(
          commits.map(async (c) =>
            Number(
              (
                await Bun.$`git -C ${clone} rev-list --count ${c}..${head}`.text()
              ).trim(),
            ),
          ),
        )),
      )
    : 0
  if (behind >= REFRESH_COMMITS) {
    console.log(
      `main が課題のコミットから ${behind} コミット進んだため、課題を作り直します`,
    )
    // 外した課題の計測は残す。課題の組が変わると計測の条件も変わり、基準版と予算の基準はこのモデルで測り直す
    retire([...m.tasks('val'), ...m.tasks('test')].map((t) => t.id))
  }
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
  await refresh(await sync())
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
  retireSolved()
  const lineage = openLineage(m).pool()
  console.log(
    `ループ ${cycle} 終了: 候補 ${lineage.length} 件、基準版 ${m.meta('base')?.slice(0, 7)}、今期の残り $${ledger.remaining('self').toFixed(2)}`,
  )
}
