// 改良の対象を版ごとに子プロセスとして動かす（固定部、ADR 0022）。版は hypharness 自身の統合ブランチの先端
// （検査を通ったコミットだけが積まれる）。その版が結果も誤りも書かずに落ちたら壊れた版として記録し、
// 固定部と同じ作業ツリーの版で動かし直す
import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { CostLimitError, ERROR, type Job, RESULT, type WorkerError } from '../shared/contract.ts'
import { BRANCH, git, type Roles } from './pipeline.ts'
import type { Store } from './store.ts'

export type WorkerOptions = {
  // hypharness 自身のリポジトリ（固定部が動いている作業ツリー）
  harness: string
  // 版を取り出しておく場所
  versions: string
  relay: string
  host: string
  store: Store
}

type Outcome = { kind: 'result'; value: any } | { kind: 'error'; error: WorkerError } | { kind: 'crash'; output: string }

export function createWorkers(options: WorkerOptions) {
  const { harness, versions, relay, host, store } = options
  const bad = new Set<string>()

  const latest = () => {
    try {
      return git(harness, 'rev-parse', '--verify', '-q', BRANCH)
    } catch {
      return undefined
    }
  }

  // ponytail: node_modules は固定部のものを共有する。依存を足した版は起動できずに落ち、作業ツリーの版で動く
  function checkout(sha: string) {
    const dir = join(versions, sha)
    if (existsSync(dir)) return dir
    const tmp = `${dir}.tmp`
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const archive = Bun.spawnSync(['sh', '-c', `git -C "${harness}" archive ${sha} | tar -x -C "${tmp}"`], { stderr: 'pipe' })
    if (archive.exitCode !== 0) throw new Error(`版 ${sha.slice(0, 8)} を取り出せませんでした: ${archive.stderr.toString()}`)
    symlinkSync(join(harness, 'node_modules'), join(tmp, 'node_modules'))
    renameSync(tmp, dir)
    return dir
  }

  async function spawn(dir: string, job: Job): Promise<Outcome> {
    const proc = Bun.spawn([process.execPath, join(dir, 'harness', 'worker.ts')], {
      cwd: dir,
      // モデルの認証情報は中継が持つので渡さない
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        ...(process.env.PARALLEL_API_KEY && { PARALLEL_API_KEY: process.env.PARALLEL_API_KEY }),
        HYPH_JOB: JSON.stringify(job),
        HYPH_RELAY: relay,
        HYPH_HOST: host,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    await proc.exited
    const last = out.trimEnd().split('\n').at(-1) ?? ''
    if (last.startsWith(RESULT)) return { kind: 'result', value: JSON.parse(last.slice(RESULT.length)) }
    if (last.startsWith(ERROR)) return { kind: 'error', error: JSON.parse(last.slice(ERROR.length)) }
    return { kind: 'crash', output: `${err}\n${out}`.trim().slice(-1000) }
  }

  async function run(job: Job) {
    const sha = latest()
    const candidates = [
      ...(sha && !bad.has(sha) ? [{ sha, label: `版 ${sha.slice(0, 8)}` }] : []),
      { sha: '', label: '作業ツリーの版' },
    ]
    for (const c of candidates) {
      const outcome = await spawn(c.sha ? checkout(c.sha) : harness, job)
      if (outcome.kind === 'result') return outcome.value
      if (outcome.kind === 'error') {
        throw outcome.error.cost ? new CostLimitError(outcome.error.message) : new Error(outcome.error.message)
      }
      if (c.sha) bad.add(c.sha)
      store.act('host', 'fail', `${c.label} の ${job.role} が落ちました。${c.sha ? '作業ツリーの版で動かし直します。' : ''}${outcome.output}`)
    }
    throw new Error(`${job.role} をどの版でも動かせませんでした`)
  }

  const roles: Roles = { decompose: (job) => run(job), solve: (job) => run(job) }
  return { run, roles, bad }
}
