import { DurableObject } from 'cloudflare:workers'

const encoder = new TextEncoder()
// ブラウザへは1行に1つの JSON（{"delta"} か {"error"}）で流す。途中で失敗しても本文と区別できる
const line = (event: { delta: string } | { error: string }) =>
  encoder.encode(`${JSON.stringify(event)}\n`)

// 1アカウントの手元のランナーとの WebSocket を持つ。エージェントの記憶と処理はランナーにあり、
// Worker は発言と応答を中継するだけにする
export class Runner extends DurableObject<Env> {
  // 応答を流している途中のストリーム。流しているあいだはリクエストが続くため、インスタンスは休止しない
  private streams = new Map<
    string,
    ReadableStreamDefaultController<Uint8Array>
  >()

  async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('WebSocket で接続してください', { status: 426 })
    }
    for (const ws of this.ctx.getWebSockets()) {
      ws.close(1000, '新しいランナーが接続しました')
    }
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  connected() {
    return this.ctx.getWebSockets().length > 0
  }

  // ponytail: タイムアウトなし。ランナーが応答しないと切断まで待つ。必要になったら期限を足す
  chat(agent: string, message: string) {
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) throw new Error('ランナーが接続されていません')
    const id = crypto.randomUUID()
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.streams.set(id, controller)
        ws.send(JSON.stringify({ id, agent, message }))
      },
      cancel: () => {
        this.streams.delete(id)
      },
    })
  }

  webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    const { id, delta, error } = JSON.parse(String(data))
    const controller = this.streams.get(id)
    if (!controller) return
    if (typeof delta === 'string') {
      controller.enqueue(line({ delta }))
      return
    }
    if (error !== undefined) {
      controller.enqueue(
        line({ error: `ランナーでの呼び出しに失敗しました: ${error}` }),
      )
    }
    controller.close()
    this.streams.delete(id)
  }

  webSocketClose() {
    for (const controller of this.streams.values()) {
      controller.enqueue(line({ error: 'ランナーとの接続が切れました' }))
      controller.close()
    }
    this.streams.clear()
  }
}
