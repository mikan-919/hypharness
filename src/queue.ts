// 中継が持つタスクの待ち行列と実行権。Durable Object の SQLite でも bun:sqlite でも動くよう、SQL を実行する関数だけを受け取る
export type Value = string | number | null
export type Sql = <T>(query: string, ...params: Value[]) => T[]

// 実行権の期限。ノードは期限の前に更新し、更新が止まったら期限の後にタスクを待ち行列に戻す
export const LEASE_MS = 45_000
// ponytail: 履歴は新しい5000件・90日まで。利用者ごとの Durable Object に置くため、1人分の上限になる
const HISTORY_LIMIT = 5000
const HISTORY_MS = 90 * 24 * 60 * 60_000

export type Task = {
  id: number
  // 課題文と、任意の判定コマンド。判定コマンドの終了コードが 0 なら成功とする
  statement: string
  check_command: string | null
  state: 'queued' | 'leased' | 'done'
  node: string | null
  // 実行権を発行するたびに1つ増やす。古い世代の更新や報告は受け付けない
  generation: number
  expires: number | null
  code: number | null
  // 成否（判定コマンドがなければ null）と、解いたエージェントの版（コミット）
  ok: number | null
  version: string | null
  // 確定チェックポイント（暗号化した作業領域の SHA-256）。別のノードはここから再開する
  checkpoint: string | null
  created_at: number
}
export type Grant = {
  id: number
  statement: string
  check: string | null
  generation: number
  checkpoint: string | null
}
// ノードが報告する結果。中継に置くのは数値とハッシュだけで、出力はノードの外に出さない
export type Outcome = { code: number; ok: boolean | null; version: string }

// 中継とノードの間の通知。ノードと Worker の両方から読むため、ここに置く
export type NodeInfo = { id: string; name: string }
// 期ごとの資源配分の内訳。中継に置くのは数値だけ
export type LedgerRow = {
  period: string
  kind: 'task' | 'local' | 'self' | 'verify'
  budget: number | null
  spent: number
  improvement: number
}
// ノードから届く通知。ready は割り当てを待っていること、renew は実行権の更新、done は終了の報告、ledger は資源配分の内訳
export type NodeMessage =
  | { type: 'ready' }
  | { type: 'ledger'; rows: LedgerRow[] }
  | { type: 'renew'; id: number; generation: number }
  | ({ type: 'done'; id: number; generation: number } & Outcome)
// 中継からノードへ送る指示。revoked は実行権を失ったので実行を止めること
export type RelayMessage =
  | ({ type: 'task' } & Grant)
  | { type: 'revoked'; id: number; generation: number }
export type HistoryEvent = {
  task_id: number
  generation: number
  node: string | null
  kind: 'queued' | 'leased' | 'expired' | 'done' | 'rejected'
  code: number | null
  at: number
}

export function openQueue(sql: Sql) {
  sql(`CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY,
    statement TEXT NOT NULL,
    check_command TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    node TEXT,
    generation INTEGER NOT NULL DEFAULT 0,
    expires INTEGER,
    code INTEGER,
    ok INTEGER,
    version TEXT,
    checkpoint TEXT,
    created_at INTEGER NOT NULL
  )`)
  // 段階3より前の表（command だけを持つ）を移す
  const columns = new Set(
    sql<{ name: string }>('PRAGMA table_info(tasks)').map((c) => c.name),
  )
  if (columns.has('command')) {
    sql('ALTER TABLE tasks RENAME COLUMN command TO statement')
    sql('ALTER TABLE tasks ADD COLUMN check_command TEXT')
    sql('ALTER TABLE tasks ADD COLUMN ok INTEGER')
    sql('ALTER TABLE tasks ADD COLUMN version TEXT')
  }
  // 段階6より前の表には checkpoint の列がない
  if (!columns.has('checkpoint')) {
    sql('ALTER TABLE tasks ADD COLUMN checkpoint TEXT')
  }
  sql(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY,
    task_id INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    node TEXT,
    kind TEXT NOT NULL,
    code INTEGER,
    at INTEGER NOT NULL
  )`)

  const record = (e: HistoryEvent) => {
    sql(
      'INSERT INTO history (task_id, generation, node, kind, code, at) VALUES (?, ?, ?, ?, ?, ?)',
      e.task_id,
      e.generation,
      e.node,
      e.kind,
      e.code,
      e.at,
    )
    sql(
      'DELETE FROM history WHERE at < ? OR id <= (SELECT MAX(id) FROM history) - ?',
      e.at - HISTORY_MS,
      HISTORY_LIMIT,
    )
  }

  // 期限の切れた実行権を回収し、タスクを待ち行列に戻す
  const reclaim = (now: number) => {
    const expired = sql<Task>(
      "SELECT * FROM tasks WHERE state = 'leased' AND expires <= ?",
      now,
    )
    for (const t of expired) {
      sql(
        "UPDATE tasks SET state = 'queued', node = NULL, expires = NULL WHERE id = ?",
        t.id,
      )
      record({ ...held(t), kind: 'expired', code: null, at: now })
    }
  }

  const held = (t: Task) => ({
    task_id: t.id,
    generation: t.generation,
    node: t.node,
  })

  // 報告を受け付けるのは、同じノードが持つ、期限内の同じ世代の実行権だけ
  const current = (id: number, generation: number, node: string, now: number) =>
    sql<Task>(
      "SELECT * FROM tasks WHERE id = ? AND generation = ? AND node = ? AND state = 'leased' AND expires > ?",
      id,
      generation,
      node,
      now,
    )[0]

  return {
    reclaim,

    add(statement: string, check: string | null, now: number) {
      const [{ id }] = sql<{ id: number }>(
        'INSERT INTO tasks (statement, check_command, created_at) VALUES (?, ?, ?) RETURNING id',
        statement,
        check,
        now,
      )
      record({
        task_id: id,
        generation: 0,
        node: null,
        kind: 'queued',
        code: null,
        at: now,
      })
      return id
    },

    // ponytail: 1ノードが同時に持てる実行権は1つ。ノードの並列度を測ってから増やす
    claim(node: string, now: number): Grant | null {
      reclaim(now)
      const busy = sql(
        "SELECT 1 FROM tasks WHERE state = 'leased' AND node = ?",
        node,
      ).length
      if (busy) return null
      const [t] = sql<Task>(
        "SELECT * FROM tasks WHERE state = 'queued' ORDER BY id LIMIT 1",
      )
      if (!t) return null
      const generation = t.generation + 1
      sql(
        "UPDATE tasks SET state = 'leased', node = ?, generation = ?, expires = ? WHERE id = ?",
        node,
        generation,
        now + LEASE_MS,
        t.id,
      )
      record({
        task_id: t.id,
        generation,
        node,
        kind: 'leased',
        code: null,
        at: now,
      })
      return {
        id: t.id,
        statement: t.statement,
        check: t.check_command,
        generation,
        checkpoint: t.checkpoint,
      }
    },

    // その実行権を今持っているか。チェックポイントの読み書きはその保持者だけに許す
    holds: (id: number, generation: number, node: string, now: number) =>
      Boolean(current(id, generation, node, now)),

    checkpoint(
      id: number,
      generation: number,
      node: string,
      hash: string,
      now: number,
    ) {
      if (!current(id, generation, node, now)) return false
      sql('UPDATE tasks SET checkpoint = ? WHERE id = ?', hash, id)
      return true
    },

    renew(id: number, generation: number, node: string, now: number) {
      if (!current(id, generation, node, now)) return false
      sql('UPDATE tasks SET expires = ? WHERE id = ?', now + LEASE_MS, id)
      return true
    },

    finish(
      id: number,
      generation: number,
      node: string,
      outcome: Outcome,
      now: number,
    ) {
      const accepted = Boolean(current(id, generation, node, now))
      if (accepted) {
        sql(
          "UPDATE tasks SET state = 'done', code = ?, ok = ?, version = ?, expires = NULL WHERE id = ?",
          outcome.code,
          outcome.ok === null ? null : Number(outcome.ok),
          outcome.version,
          id,
        )
      }
      record({
        task_id: id,
        generation,
        node,
        kind: accepted ? 'done' : 'rejected',
        code: outcome.code,
        at: now,
      })
      return accepted
    },

    nextExpiry() {
      return (
        sql<{ next: number | null }>(
          "SELECT MIN(expires) AS next FROM tasks WHERE state = 'leased'",
        )[0]?.next ?? null
      )
    },

    tasks: (limit = 100) =>
      sql<Task>('SELECT * FROM tasks ORDER BY id DESC LIMIT ?', limit),

    history: (taskId: number) =>
      sql<HistoryEvent>(
        'SELECT task_id, generation, node, kind, code, at FROM history WHERE task_id = ? ORDER BY id',
        taskId,
      ),
  }
}

export type Queue = ReturnType<typeof openQueue>
