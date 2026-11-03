// 段階7の Act: 作業領域の課題で成功した試行の差分を、そのリポジトリへの PR にする。
// 本文は変更点を簡潔にまとめたものにする。簡潔でなければ、人が PR を閉じて捨てる
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Measure } from './measure'
import type { Complete } from './model'
import type { Workspace } from './tasks'

// 要約役に見せる差分の上限
const PATCH_LIMIT = 30_000

export const candidates = (m: Measure) =>
  m.db
    .query<{ run: number; task: number; statement: string; patch: string }, []>(
      `SELECT r.id AS run, r.task_id AS task, t.statement, r.patch FROM runs r
        JOIN tasks t ON t.id = r.task_id WHERE r.patch <> '' ORDER BY r.id`,
    )
    .all()
    .map((r) => ({ ...r, lines: r.patch.split('\n').length }))

// GitHub のリモートの URL から owner/name を取り出す
export function repoName(remote: string) {
  const match = remote.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(\.git)?$/)
  if (!match) throw new Error(`GitHub のリポジトリではありません: ${remote}`)
  return match[1]
}

// 1行目を題（英語）、残りを本文（日本語の箇条書き）として返す
export function parseSummary(text: string) {
  const [title = '', ...rest] = text.trim().split('\n')
  const clean = title.replace(/^[#*\s]+|[*\s]+$/g, '')
  if (!clean) throw new Error('要約が空です')
  return { title: clean, body: rest.join('\n').trim() }
}

async function summarize(statement: string, patch: string, complete: Complete) {
  const reply = await complete({
    systemPrompt:
      'あなたは、リポジトリへの変更を PR にまとめる役です。修飾表現を使わず、事実だけを書いてください。',
    messages: [
      {
        role: 'user',
        content: `次の変更を PR にします。1行目に英語のコミットの題（変更の内容を1行）、2行目以降に日本語で変更点を3行以内の箇条書きで書いてください。それ以外は書かないでください。

課題:
${statement}

差分:
${patch.slice(0, PATCH_LIMIT)}`,
        timestamp: Date.now(),
      },
    ],
  })
  return parseSummary(
    reply.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n'),
  )
}

// 試行の差分を、課題のコミットから切ったブランチに当てて push し、PR を作る。作った PR の URL を返す
export async function pr(m: Measure, run: number, complete: Complete) {
  const done = m.meta(`pr:${run}`)
  if (done) return done
  const row = m.db
    .query<
      {
        patch: string | null
        task: number
        statement: string
        workspace: string | null
      },
      [number]
    >(
      `SELECT r.patch, r.task_id AS task, t.statement, t.workspace FROM runs r
        JOIN tasks t ON t.id = r.task_id WHERE r.id = ?`,
    )
    .get(run)
  if (!row?.patch || !row.workspace) {
    throw new Error(`試行 ${run} に作業領域の差分がありません`)
  }
  const w = JSON.parse(row.workspace) as Workspace
  const remote = (
    await Bun.$`git -C ${w.repo} remote get-url origin`.text()
  ).trim()
  const name = repoName(remote)
  const branch = `hyph/run-${run}`
  const dir = await mkdtemp(join(tmpdir(), 'hyph-pr-'))
  try {
    await Bun.$`git clone -q ${w.repo} ${dir}`.quiet()
    await Bun.$`git -C ${dir} checkout -q -b ${branch} ${w.commit}`.quiet()
    const file = join(dir, '.git', 'hyph.patch')
    await Bun.write(file, row.patch)
    await Bun.$`git -C ${dir} apply --index ${file}`.quiet()
    const { title, body } = await summarize(row.statement, row.patch, complete)
    await Bun.$`git -C ${dir} commit -q -m ${title}`.quiet()
    await Bun.$`git -C ${dir} push -q ${remote} ${branch}`.quiet()
    const url = (
      await Bun.$`gh pr create -R ${name} --head ${branch} --title ${title} --body ${`${body}\n\n---\nhypharness の試行 ${run}（課題 ${row.task}）で、隠しテストと判定を通った変更です。`}`
        .cwd(dir)
        .text()
    ).trim()
    m.setMeta(`pr:${run}`, url)
    return url
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
