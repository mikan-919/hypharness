import type { AssistantMessage, Context } from '@earendil-works/pi-ai'

export type Complete = (context: Context) => Promise<AssistantMessage>
// 1回の実行で使える費用。limit が null なら上限なし（予算の基準を作る最初の計測）
export type Budget = { limit: number | null; spent: number }
export type Call = { context: Context; reply: AssistantMessage }

// 候補がモデルを呼べる唯一の経路。隔離環境にはこの Unix ソケットだけを見せ、認証情報とモデルの選択はこのプロセスが持つ。
// ponytail: 予算は呼ぶ前に確かめるため、最後の1回の分だけ上限を超えうる。超過を許せなくなったら最大出力から見積もる
export function serveModel(
  socket: string,
  complete: Complete,
  budget: Budget,
  onCall: (call: Call) => void,
) {
  return Bun.serve({
    unix: socket,
    async fetch(request) {
      if (request.method !== 'POST') {
        return Response.json(
          { error: 'POST で送ってください' },
          { status: 405 },
        )
      }
      if (budget.limit !== null && budget.spent >= budget.limit) {
        return Response.json(
          { error: '計算予算を使い切りました' },
          { status: 402 },
        )
      }
      const context = (await request.json().catch(() => null)) as Context
      if (!Array.isArray(context?.messages)) {
        return Response.json(
          { error: 'messages を持つ Context を送ってください' },
          { status: 400 },
        )
      }
      const reply = await complete(context)
      budget.spent += reply.usage.cost.total
      onCall({ context, reply })
      return Response.json(reply)
    },
    error: (e) =>
      Response.json(
        { error: `モデルの呼び出しに失敗しました: ${e.message}` },
        { status: 502 },
      ),
  })
}
