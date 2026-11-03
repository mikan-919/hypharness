import { DurableObject } from 'cloudflare:workers'
import {
  type NodeInfo,
  type NodeMessage,
  openQueue,
  type Queue,
  type RelayMessage,
} from './queue'

const parse = (data: string | ArrayBuffer): NodeMessage => {
  const m = JSON.parse(String(data))
  if (m?.type === 'ready') return m
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
    this.queue = openQueue(
      (query, ...params) =>
        ctx.storage.sql.exec(query, ...params).toArray() as never[],
    )
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

  private send(ws: WebSocket, message: RelayMessage) {
    ws.send(JSON.stringify(message))
  }

  private nodeOf(ws: WebSocket) {
    return ws.deserializeAttachment() as NodeInfo
  }
}
