import { DurableObject } from 'cloudflare:workers'
import {
  type LedgerRow,
  type LineageRow,
  type NodeInfo,
  type NodeMessage,
  openQueue,
  type ProposalRow,
  type Queue,
  type RelayMessage,
} from './queue'

// 資源配分の内訳の行。期は日付、区分は4つ、金額は有限の数
const ledgerRow = (r: Record<string, unknown>) =>
  typeof r?.period === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(r.period) &&
  ['task', 'local', 'self', 'verify'].includes(r.kind as string) &&
  (r.budget === null || Number.isFinite(r.budget)) &&
  Number.isFinite(r.spent) &&
  Number.isFinite(r.improvement)
// 1回に受け取る内訳の行の上限（14期 × 4区分を収める）
const LEDGER_ROWS = 100
// ponytail: 1セッションの系統と提案は新しい500件まで受け取る。画面で全件を見る必要が出たら、ページに分けて送る
const EVOLUTION_ROWS = 500
const commit = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v)
const lineageRow = (r: Record<string, unknown>) =>
  commit(r?.commit) &&
  (r.parent === null || commit(r.parent)) &&
  typeof r.status === 'string' &&
  r.status.length <= 16 &&
  (r.val === null || Number.isFinite(r.val))
const proposalRow = (r: Record<string, unknown>) =>
  Number.isSafeInteger(r?.id) &&
  commit(r.parent) &&
  Array.isArray(r.files) &&
  r.files.length <= 50 &&
  r.files.every((f) => typeof f === 'string' && f.length <= 200) &&
  Number.isSafeInteger(r.lines) &&
  ['pending', 'approved', 'rejected'].includes(r.status as string) &&
  // 画面でリンクにするため、GitHub の URL だけを受け取る
  (r.pr === null ||
    (typeof r.pr === 'string' &&
      r.pr.length <= 200 &&
      r.pr.startsWith('https://github.com/')))
export const sessionName = (v: unknown): v is string =>
  typeof v === 'string' && /^[\w-]{1,32}$/.test(v)

const parse = (data: string | ArrayBuffer): NodeMessage => {
  const m = JSON.parse(String(data))
  if (m?.type === 'ready') return m
  if (
    m?.type === 'ledger' &&
    Array.isArray(m.rows) &&
    m.rows.length <= LEDGER_ROWS &&
    m.rows.every(ledgerRow)
  ) {
    return m
  }
  if (
    m?.type === 'evolution' &&
    sessionName(m.session) &&
    Array.isArray(m.lineage) &&
    m.lineage.length <= EVOLUTION_ROWS &&
    m.lineage.every(lineageRow) &&
    Array.isArray(m.proposals) &&
    m.proposals.length <= EVOLUTION_ROWS &&
    m.proposals.every(proposalRow)
  ) {
    return m
  }
  const ints = (...keys: string[]) =>
    keys.every((k) => Number.isSafeInteger(m[k]))
  if (m?.type === 'renew' && ints('id', 'generation')) return m
  if (
    m?.type === 'done' &&
    ints('id', 'generation', 'code') &&
    (m.ok === null || typeof m.ok === 'boolean') &&
    typeof m.version === 'string' &&
    /^[0-9a-f]{40}$/.test(m.version)
  ) {
    return m
  }
  throw new Error('ノードからの通知の形式が不正です')
}

// 1アカウントの中継。ノードとの WebSocket、タスクの待ち行列、実行権を持つ。
// 実行権の持ち主はノード ID で SQL に残すため、休止して起き直しても失われない
export class Relay extends DurableObject<Env> {
  private queue: Queue

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.queue = this.init()
  }

  private init() {
    const { sql } = this.ctx.storage
    const queue = openQueue(
      (query, ...params) => sql.exec(query, ...params).toArray() as never[],
    )
    sql.exec(`CREATE TABLE IF NOT EXISTS ledger (
      period TEXT NOT NULL,
      kind TEXT NOT NULL,
      budget REAL,
      spent REAL NOT NULL,
      improvement REAL NOT NULL,
      PRIMARY KEY (period, kind)
    )`)
    // セッションごとの系統と提案は、ノードが送った最新の一覧で置き換える。承認の依頼はノードが処理するまで残す
    sql.exec(`CREATE TABLE IF NOT EXISTS evolution (
      session TEXT PRIMARY KEY,
      lineage TEXT NOT NULL,
      proposals TEXT NOT NULL,
      at INTEGER NOT NULL
    )`)
    sql.exec(`CREATE TABLE IF NOT EXISTS approvals (
      session TEXT NOT NULL,
      id INTEGER NOT NULL,
      PRIMARY KEY (session, id)
    )`)
    return queue
  }

  // 利用者の記録（タスク・履歴・費用・進化の記録・承認の依頼）をすべて消す。接続中のノードは切り、再接続させる
  async wipe() {
    for (const ws of this.ctx.getWebSockets())
      ws.close(1000, '記録を消しました')
    await this.ctx.storage.deleteAll()
    this.queue = this.init()
  }

  // Worker がノード用トークンを確かめ、ノードの ID と名前をヘッダーに入れて渡す
  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket で接続してください', { status: 426 })
    }
    const node: NodeInfo = {
      id: request.headers.get('x-node-id') ?? '',
      name: request.headers.get('x-node-name') ?? '',
    }
    // 同じノードの古い接続は閉じる。再接続の前の接続が残っていても、割り当て先が1つに定まる
    for (const ws of this.ctx.getWebSockets()) {
      if (this.nodeOf(ws).id === node.id) ws.close(1000, '再接続しました')
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment(node)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    const node = this.nodeOf(ws)
    const m = parse(data)
    const now = Date.now()
    if (
      m.type === 'renew' &&
      !this.queue.renew(m.id, m.generation, node.id, now)
    ) {
      this.send(ws, { type: 'revoked', id: m.id, generation: m.generation })
    }
    if (m.type === 'ledger') {
      for (const r of m.rows) {
        this.ctx.storage.sql.exec(
          'INSERT OR REPLACE INTO ledger (period, kind, budget, spent, improvement) VALUES (?, ?, ?, ?, ?)',
          r.period,
          r.kind,
          r.budget,
          r.spent,
          r.improvement,
        )
      }
      return
    }
    if (m.type === 'evolution') {
      this.ctx.storage.sql.exec(
        'INSERT OR REPLACE INTO evolution (session, lineage, proposals, at) VALUES (?, ?, ?, ?)',
        m.session,
        JSON.stringify(m.lineage),
        JSON.stringify(m.proposals),
        now,
      )
      // ノードが処理した（承認待ちでなくなった）提案の依頼は消し、残りは送り直す
      for (const p of m.proposals) {
        if (p.status !== 'pending') {
          this.ctx.storage.sql.exec(
            'DELETE FROM approvals WHERE session = ? AND id = ?',
            m.session,
            p.id,
          )
        }
      }
      this.sendApprovals(ws, m.session)
      return
    }
    if (m.type === 'done') {
      const { code, ok, version } = m
      this.queue.finish(m.id, m.generation, node.id, { code, ok, version }, now)
    }
    await this.dispatch()
  }

  // 切断では実行権を回収しない。ノードは切断中も実行を続け、再接続して期限内に更新すれば持ち続けられる
  async alarm() {
    this.queue.reclaim(Date.now())
    await this.dispatch()
  }

  async add(statement: string, check: string | null) {
    const id = this.queue.add(statement, check, Date.now())
    await this.dispatch()
    return id
  }

  // 計測の試行を待ち行列に入れる。payload は R2 に置いた暗号化済みの中身の SHA-256
  async addTrial(payload: string) {
    const id = this.queue.add('', null, Date.now(), payload)
    await this.dispatch()
    return id
  }

  trial(id: number) {
    const t = this.queue.get(id)
    return t?.kind === 'trial'
      ? { state: t.state, code: t.code, result: t.result, payload: t.payload }
      : null
  }

  result(id: number, generation: number, node: string, hash: string) {
    return this.queue.result(id, generation, node, hash, Date.now())
  }

  checkpointOf(id: number) {
    return this.queue.get(id)?.checkpoint ?? null
  }

  // 画面での承認。そのセッションの提案が承認待ちなら依頼を残し、接続中のノードに送る
  approve(session: string, id: number) {
    const row = this.ctx.storage.sql
      .exec('SELECT proposals FROM evolution WHERE session = ?', session)
      .toArray()[0] as { proposals: string } | undefined
    const proposals = row ? (JSON.parse(row.proposals) as ProposalRow[]) : []
    if (!proposals.some((p) => p.id === id && p.status === 'pending')) {
      return false
    }
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO approvals (session, id) VALUES (?, ?)',
      session,
      id,
    )
    for (const ws of this.ctx.getWebSockets()) this.sendApprovals(ws, session)
    return true
  }

  holds(id: number, generation: number, node: string) {
    return this.queue.holds(id, generation, node, Date.now())
  }

  checkpoint(id: number, generation: number, node: string, hash: string) {
    return this.queue.checkpoint(id, generation, node, hash, Date.now())
  }

  status() {
    return {
      nodes: this.ctx.getWebSockets().map((ws) => this.nodeOf(ws)),
      tasks: this.queue.tasks(),
      ledger: this.ctx.storage.sql
        .exec(
          'SELECT * FROM ledger ORDER BY period DESC, kind LIMIT ?',
          LEDGER_ROWS,
        )
        .toArray() as LedgerRow[],
      evolution: (
        this.ctx.storage.sql
          .exec('SELECT * FROM evolution ORDER BY session')
          .toArray() as {
          session: string
          lineage: string
          proposals: string
          at: number
        }[]
      ).map((e) => {
        const requested = new Set(
          (
            this.ctx.storage.sql
              .exec('SELECT id FROM approvals WHERE session = ?', e.session)
              .toArray() as { id: number }[]
          ).map((a) => a.id),
        )
        return {
          session: e.session,
          at: e.at,
          lineage: JSON.parse(e.lineage) as LineageRow[],
          proposals: (JSON.parse(e.proposals) as ProposalRow[]).map((p) =>
            requested.has(p.id) && p.status === 'pending'
              ? { ...p, status: 'requested' as const }
              : p,
          ),
        }
      }),
    }
  }

  history(taskId: number) {
    return this.queue.history(taskId)
  }

  // 接続中で実行権を持たないノードに、待ち行列の先頭から割り当てる
  private async dispatch() {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const grant = this.queue.claim(this.nodeOf(ws).id, now)
      if (grant) this.send(ws, { type: 'task', ...grant })
    }
    const next = this.queue.nextExpiry()
    if (next !== null) await this.ctx.storage.setAlarm(next)
  }

  // 承認の依頼は、どのノードがそのセッションを持つか中継が知らないため、接続中のノードすべてに送る。
  // ノードは自分のセッションの依頼だけを処理する
  private sendApprovals(ws: WebSocket, session: string) {
    for (const a of this.ctx.storage.sql
      .exec('SELECT id FROM approvals WHERE session = ?', session)
      .toArray() as { id: number }[]) {
      this.send(ws, { type: 'approve', session, id: a.id })
    }
  }

  private send(ws: WebSocket, message: RelayMessage) {
    ws.send(JSON.stringify(message))
  }

  private nodeOf(ws: WebSocket) {
    return ws.deserializeAttachment() as NodeInfo
  }
}
