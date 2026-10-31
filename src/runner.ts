import { DurableObject } from 'cloudflare:workers'

export type Message = { role: 'user' | 'assistant'; content: string }

type Pending = { resolve: (text: string) => void; reject: (e: Error) => void }

// 1アカウントの手元のランナーとの WebSocket を持つ。Workers から chatgpt.com へは接続できないため、
// Codex の呼び出しはランナーに任せる
export class Runner extends DurableObject<Env> {
  // 応答待ちの依頼。ランナーの応答を待つあいだはリクエストが続くため、インスタンスは休止しない
  private pending = new Map<string, Pending>()

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

  complete(instructions: string, messages: Message[]) {
    const ws = this.ctx.getWebSockets()[0]
    if (!ws) throw new Error('ランナーが接続されていません')
    const id = crypto.randomUUID()
    ws.send(JSON.stringify({ id, instructions, messages }))
    // ponytail: タイムアウトなし。ランナーが応答しないと切断まで待つ。必要になったら期限を足す
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
  }

  webSocketMessage(_ws: WebSocket, data: string | ArrayBuffer) {
    const { id, text, error } = JSON.parse(String(data))
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (typeof text === 'string') pending.resolve(text)
    else
      pending.reject(new Error(`ランナーでの呼び出しに失敗しました: ${error}`))
  }

  webSocketClose() {
    for (const { reject } of this.pending.values()) {
      reject(new Error('ランナーとの接続が切れました'))
    }
    this.pending.clear()
  }
}
