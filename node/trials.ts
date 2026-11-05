// 計測の試行を中継経由で別のノードに解かせる（図の実験配置）。計測する側は、課題・候補のコード・作業領域のリポジトリを
// 暗号化して中継に置き、実行権を持つノードがそれを解いて、暗号化した結果を置く。鍵は利用者のノードだけが持つ
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantMessage, Context } from '@earendil-works/pi-ai'
import { attempt, DIR } from './measure'
import type { Budget, Complete } from './model'
import type { EvalTask } from './tasks'
import { loadKey, pack, seal, sha256, unpack, unseal } from './vault'

// 結果を待つ間隔
export const trialTiming = { pollMs: 10_000 }
// 暗号の認証付きデータ。試行の中身と結果を、チェックポイントや別の種類のデータと取り違えないようにする
const PAYLOAD_LABEL = 'trial-payload'
const RESULT_LABEL = 'trial-result'

type Call = { context: Context; reply: AssistantMessage }
export type TrialResult = {
  ok: boolean
  code: number | null
  patch: string | null
  cost: number
  calls: Call[]
}
// 試行の中身。作業領域の課題では、リポジトリはコミットの中身の tar で、開発環境の設定は本文で渡す。
// 読み取り専用のディレクトリ（依存の取得済みの置き場など）は、解くノードの同じパスにあるものを使う
type Payload = {
  task: Omit<EvalTask, 'workspace'>
  workspace: { tree: string; prelude: string; mounts: string[] } | null
  agent: string
  // 候補のコミット。解いたノードが中継に報告する版になる
  commit: string
  limit: number | null
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64')
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

// 中継の URL・ノード用トークン・暗号の鍵。既定はこのノードのペアリングの設定と鍵
export type Link = { url: string; token: string; key: CryptoKey }
export async function loadLink(): Promise<Link> {
  const config = (await Bun.file(join(DIR, 'node.json')).json()) as {
    url: string
    token: string
  }
  return { ...config, key: await loadKey(join(DIR, 'vault.key')) }
}

function relay(link: Link) {
  const { key } = link
  const config = link
  const call = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${config.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        ...init.headers,
      },
    })
    if (!response.ok) {
      throw new Error(
        `中継が断りました (${response.status} ${path}): ${await response.text()}`,
      )
    }
    return response
  }
  return { key, call }
}

// 試行を中継に置き、別のノードが解き終えるまで待って結果を返す
export async function remoteAttempt(
  task: EvalTask,
  agent: string,
  commit: string,
  limit: number | null,
  link?: Link,
): Promise<TrialResult> {
  const { key, call } = relay(link ?? (await loadLink()))
  const w = task.workspace
  const payload: Payload = {
    task: (({ workspace: _, ...rest }) => rest)(task),
    workspace: w
      ? {
          tree: b64(
            new Uint8Array(
              await Bun.$`git -C ${w.repo} archive ${w.commit}`
                .quiet()
                .arrayBuffer(),
            ),
          ),
          prelude: await Bun.file(w.prelude).text(),
          mounts: w.mounts,
        }
      : null,
    agent: b64(await pack(agent)),
    commit,
    limit,
  }
  const sealed = await seal(
    key,
    PAYLOAD_LABEL,
    new TextEncoder().encode(JSON.stringify(payload)),
  )
  const { id } = (await (
    await call('/node/trials', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: sealed,
    })
  ).json()) as { id: number }
  console.log(`試行 ${id} を中継に置きました。ノードが解くのを待ちます`)
  while (true) {
    await Bun.sleep(trialTiming.pollMs)
    const t = (await (await call(`/node/trials/${id}`)).json()) as {
      state: string
      result: string | null
    }
    if (t.state !== 'done') continue
    if (!t.result) throw new Error(`試行 ${id} は結果なしで終わりました`)
    const blob = new Uint8Array(
      await (await call(`/node/trials/${id}/result`)).arrayBuffer(),
    )
    if ((await sha256(blob)) !== t.result) {
      throw new Error(`試行 ${id} の結果のハッシュが記録と合いません`)
    }
    return JSON.parse(
      new TextDecoder().decode(await unseal(key, RESULT_LABEL, blob)),
    ) as TrialResult
  }
}

// 実行権を受け取ったノードで、試行の中身を取得して解き、暗号化した結果を置く。成否を返す
export async function solveTrial(
  grant: { id: number; generation: number; payload: string | null },
  complete: Complete,
  signal: AbortSignal,
  link?: Link,
) {
  const { key, call } = relay(link ?? (await loadLink()))
  const base = `/node/trials/${grant.id}/${grant.generation}`
  const blob = new Uint8Array(
    await (await call(`${base}/payload`)).arrayBuffer(),
  )
  if ((await sha256(blob)) !== grant.payload) {
    throw new Error('試行の中身のハッシュが記録と合いません')
  }
  const p = JSON.parse(
    new TextDecoder().decode(await unseal(key, PAYLOAD_LABEL, blob)),
  ) as Payload
  const dir = await mkdtemp(join(tmpdir(), 'hyph-trial-'))
  try {
    const agent = join(dir, 'agent')
    await mkdir(agent)
    await unpack(agent, bytes(p.agent))
    let task: EvalTask = { ...p.task }
    if (p.workspace) {
      const missing = p.workspace.mounts.filter((m) => !existsSync(m))
      if (missing.length) {
        throw new Error(
          `このノードには作業領域の読み取り専用のディレクトリがありません: ${missing.join(', ')}`,
        )
      }
      // コミットの中身から1コミットだけのリポジトリを作り、そのコミットを課題のコミットにする
      const repo = join(dir, 'repo')
      await mkdir(repo)
      await unpack(repo, bytes(p.workspace.tree))
      await Bun.$`git -C ${repo} init -q && git -C ${repo} add -A && git -C ${repo} -c user.name=hyph -c user.email=hyph@localhost commit -qm trial`.quiet()
      const commit = (await Bun.$`git -C ${repo} rev-parse HEAD`.text()).trim()
      const prelude = join(dir, 'prelude.sh')
      await Bun.write(prelude, p.workspace.prelude)
      task = {
        ...task,
        workspace: { repo, commit, prelude, mounts: p.workspace.mounts },
      }
    }
    const budget: Budget = { limit: p.limit, spent: 0 }
    const calls: Call[] = []
    const { ok, code, patch } = await attempt(
      task,
      agent,
      complete,
      budget,
      (c) => calls.push(c),
      join(DIR, 'logs', `trial-${grant.id}-${grant.generation}.log`),
      { signal },
    )
    const result: TrialResult = { ok, code, patch, cost: budget.spent, calls }
    await call(`${base}/result`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: await seal(
        key,
        RESULT_LABEL,
        new TextEncoder().encode(JSON.stringify(result)),
      ),
    })
    return { ok, code, commit: p.commit }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
