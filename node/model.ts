import type { AssistantMessage, Context } from '@earendil-works/pi-ai'

// sessionId は、同じ接頭辞を持つ呼び出しを同じキャッシュに振り分けるための鍵（OpenAI の prompt_cache_key）
export type Complete = (
  context: Context,
  options?: { sessionId?: string },
) => Promise<AssistantMessage>
// 1回の実行で使える費用。limit が null なら上限なし（予算の基準を作る最初の計測）。
// outage は、モデルの障害が再試行しても回復せず、呼び出しを諦めたときの理由
export type Budget = { limit: number | null; spent: number; outage?: string }
export type Call = { context: Context; reply: AssistantMessage }

// 一時的な障害（混雑・サーバー側の失敗・時間切れ・通信の失敗）とみなす応答の誤り
const TRANSIENT =
  /\((429|5\d\d)\)|time ?out|timed out|network|ECONNRESET|fetch failed/i
// ponytail: 再試行で待つ時間も候補の制限時間（10分）に含まれる。待ちで時間切れになる試行が出たら、待ちの分だけ制限を延ばす
const RETRY_DELAYS_MS = [10_000, 30_000, 120_000]

// 一時的な障害のときだけ間隔を空けて呼び直す。それ以外の失敗の応答はそのまま返し、候補に扱わせる
async function withRetry(
  complete: Complete,
  context: Context,
  delays: number[],
  sessionId: string,
) {
  let reason = ''
  for (let i = 0; ; i++) {
    try {
      const reply = await complete(context, { sessionId })
      if (
        reply.stopReason !== 'error' ||
        !TRANSIENT.test(reply.errorMessage ?? '')
      ) {
        return { reply }
      }
      reason = reply.errorMessage ?? ''
    } catch (e) {
      reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    }
    if (i >= delays.length) return { reason }
    console.error(`モデルの呼び出しを再試行します（${i + 1}回目）: ${reason}`)
    await Bun.sleep(delays[i])
  }
}

// 候補がモデルを呼べる唯一の経路。隔離環境にはこの Unix ソケットだけを見せ、認証情報とモデルの選択はこのプロセスが持つ。
// ponytail: 予算は呼ぶ前に確かめるため、最後の1回の分だけ上限を超えうる。超過を許せなくなったら最大出力から見積もる
export function serveModel(
  socket: string,
  complete: Complete,
  budget: Budget,
  onCall: (call: Call) => void,
  delays = RETRY_DELAYS_MS,
) {
  // 1回の試行の呼び出しは会話を追記していくだけなので、同じ鍵でキャッシュに当てる
  const sessionId = crypto.randomUUID()
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
      const { reply, reason } = await withRetry(
        complete,
        context,
        delays,
        sessionId,
      )
      if (!reply) {
        budget.outage = reason
        return Response.json(
          { error: `モデルの障害が回復しません: ${reason}` },
          { status: 503 },
        )
      }
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
