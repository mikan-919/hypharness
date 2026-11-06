// モデルの呼び出しの中継（固定部、ADR 0014）。ハーネスはこの Unix ソケットからだけモデルを呼ぶ。
// 費用の記録・課題1つあたりの上限・停止（ADR 0011、0012）と、トークン数の配信（ADR 0016）を持つ
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import type { Usage } from '../shared/dialog.ts'

export type Stream = (context: Context) => AsyncIterable<AssistantMessageEvent>
export type Call = { topicId: string; taskId: string; context: Context }

// ponytail: ストリーミング中のトークン数は文字数の 1/4 で見積もる。完了時に実際の数との差を流し、合計を合わせる
const estimate = (text: string) => Math.ceil(text.length / 4)

export function createRelay(stream: Stream, limitUsd: number) {
  const spent = new Map<string, number>()
  const listeners = new Set<(usage: Usage) => void>()
  let halted = ''
  const publish = (usage: Usage) => {
    for (const listener of listeners) listener(usage)
  }

  async function* call({ topicId, taskId, context }: Call) {
    let estimated = 0
    for await (const event of stream(context)) {
      if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
        const output = estimate(event.delta)
        estimated += output
        publish({ topicId, input: 0, output, cacheRead: 0, costUsd: 0 })
      }
      if (event.type === 'done' || event.type === 'error') {
        const { usage } = event.type === 'done' ? event.message : event.error
        publish({
          topicId,
          input: usage.input,
          output: usage.output - estimated,
          cacheRead: usage.cacheRead,
          costUsd: usage.cost.total,
        })
        const total = (spent.get(taskId) ?? 0) + usage.cost.total
        spent.set(taskId, total)
        if (total >= limitUsd) halted = `課題 ${taskId} が費用の上限 $${limitUsd} に達しました`
      }
      yield event
    }
  }

  // ponytail: 上限は呼ぶ前に確かめるため、最後の1回の分だけ超えうる。超過を許せなくなったら最大出力から見積もる
  async function handle(request: Request) {
    if (request.method !== 'POST') return Response.json({ error: 'POST で送ってください' }, { status: 405 })
    if (halted) return Response.json({ error: `停止中です: ${halted}` }, { status: 423 })
    const body = (await request.json().catch(() => null)) as Call | null
    if (!body?.topicId || !body.taskId || !Array.isArray(body.context?.messages)) {
      return Response.json({ error: 'topicId・taskId と messages を持つ context を送ってください' }, { status: 400 })
    }
    const events = call(body)
    const encoder = new TextEncoder()
    // 1行に1つのイベントを JSON で流す。partial は応答の途中の全文で大きいため送らない
    return new Response(
      new ReadableStream({
        async pull(controller) {
          const { value, done } = await events.next()
          if (done) return controller.close()
          const { partial: _, ...event } = value as AssistantMessageEvent & { partial?: unknown }
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
        },
        cancel: () => void events.return(undefined),
      }),
      { headers: { 'content-type': 'application/x-ndjson' } },
    )
  }

  return {
    handle,
    listen: (socket: string) => Bun.serve({ unix: socket, fetch: handle }),
    subscribe(listener: (usage: Usage) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    halted: () => halted,
  }
}
