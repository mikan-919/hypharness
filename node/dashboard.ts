// エージェントのやり取りを図で見せるダッシュボード。課題の出力はノードの外に出さない設計のため、
// 中継には置かず、このノードの記録（計測のセッションと、実際のタスクの呼び出しの記録）を手元だけで見せる。
// 使い方: bun run dashboard [ポート]
import { Database } from 'bun:sqlite'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { buildGraph, type Call } from './dashboard/graph'
import page from './dashboard/index.html'
import { DIR } from './measure'

const LOGS = join(DIR, 'logs')
const SESSIONS = join(DIR, 'sessions')
// 一覧に出す計測の試行は、セッションごとに新しい順でこの数まで
const RUN_LIMIT = 200
const LIVE = /^(\d+)-(\d+)\.calls\.jsonl$/
const SESSION = /^[\w-]{1,32}$/

const open = (session: string) =>
  new Database(join(SESSIONS, `${session}.sqlite`), { readonly: true })

const firstStatement = (call: Call | undefined) => {
  const m = call?.context.messages[0]
  return typeof m?.content === 'string' ? m.content : ''
}

async function runs() {
  const live = await Promise.all(
    (await readdir(LOGS).catch(() => []))
      .filter((f) => LIVE.test(f))
      .map(async (file) => {
        const [, task, generation] = file.match(LIVE) as RegExpMatchArray
        const first = (await Bun.file(join(LOGS, file)).text()).split(
          '\n',
          1,
        )[0]
        return {
          file,
          task: Number(task),
          generation: Number(generation),
          at: (await stat(join(LOGS, file))).mtimeMs,
          statement: firstStatement(
            first ? JSON.parse(first) : undefined,
          ).slice(0, 200),
        }
      }),
  )
  live.sort((a, b) => b.at - a.at)
  const sessions = (await readdir(SESSIONS).catch(() => []))
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => f.slice(0, -'.sqlite'.length))
    .filter((s) => SESSION.test(s))
    .map((session) => {
      const db = open(session)
      try {
        const rows = db
          .query(
            `SELECT r.id, r.task_id AS task, r.ok, r.cost, ms.commit_id AS 'commit', ms.split, substr(t.statement, 1, 200) AS statement
              FROM runs r JOIN measurements ms ON ms.id = r.measurement_id JOIN tasks t ON t.id = r.task_id
              ORDER BY r.id DESC LIMIT ?`,
          )
          .all(RUN_LIMIT)
        return { session, runs: rows }
      } finally {
        db.close()
      }
    })
  return { live, sessions }
}

async function calls(url: URL): Promise<Call[] | null> {
  const file = url.searchParams.get('live')
  if (file !== null) {
    if (!LIVE.test(file)) return null
    const text = await Bun.file(join(LOGS, file))
      .text()
      .catch(() => null)
    if (text === null) return null
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  }
  const session = url.searchParams.get('session') ?? ''
  const run = Number(url.searchParams.get('run'))
  if (!SESSION.test(session) || !Number.isSafeInteger(run)) return null
  if (!(await Bun.file(join(SESSIONS, `${session}.sqlite`)).exists()))
    return null
  const db = open(session)
  try {
    return db
      .query<{ context: string; reply: string }, [number]>(
        'SELECT context, reply FROM calls WHERE run_id = ? ORDER BY id',
      )
      .all(run)
      .map((r) => ({
        context: JSON.parse(r.context),
        reply: JSON.parse(r.reply),
      }))
  } finally {
    db.close()
  }
}

const port = Number(process.argv[2] ?? 4173)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('使い方: bun run dashboard [ポート]')
}
// 課題の出力を含むため、このマシンの外からは開けないようにする
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  routes: {
    '/': page,
    '/api/runs': async () => Response.json(await runs()),
    '/api/graph': async (request) => {
      const found = await calls(new URL(request.url))
      return found
        ? Response.json(buildGraph(found))
        : Response.json({ error: '記録がありません' }, { status: 404 })
    },
  },
})
console.log(`ダッシュボード: ${server.url}`)
