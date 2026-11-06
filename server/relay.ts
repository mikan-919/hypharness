// モデルの呼び出しの中継（固定部、ADR 0014）。ハーネスはこの Unix ソケットからだけモデルを呼ぶ。
// 費用の記録・課題1つあたりの上限・停止（ADR 0011、0012）と、トークン数の配信（ADR 0016）を持つ
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import type { Usage } from '../shared/dialog.ts'

export type Stream = (context: Context) => AsyncIterable<AssistantMessageEvent>
export type Call = { topicId: string; taskId: string; context: Context }
export type Cost = { topicId?: string; taskId: string; costUsd: number }

// ストリーミング中の出力トークン数の見積もり。DeepSeek V4.1 Flash の応答で測った値（2026-11-06）で、
// ASCII は1文字 0.23、それ以外（日本語など）は1文字 1.1 トークン。応答が終わったら実際の数に置き換える
const estimate = (text: string) => {
  let tokens = 0
  for (const c of text) tokens += c.charCodeAt(0) < 128 ? 0.23 : 1.1
  return tokens
}

const zero = (topicId: string): Usage => ({ topicId, input: 0, output: 0, cacheRead: 0, costUsd: 0 })

export function createRelay(stream: Stream, limitUsd: number) {
  const spent = new Map<string, number>()
  // 論点ごとの、終わった呼び出しの実際の数の合計と、実行中の呼び出しの出力の見積もり
  const confirmed = new Map<string, Usage>()
  const inflight = new Map<object, { topicId: string; output: number }>()
  const listeners = new Set<(totals: Record<string, Usage>) => void>()
  let halted = ''

  // 画面へは増分ではなく合計を送る。画面を開き直しても数が戻らない
  function totals() {
    const out: Record<string, Usage> = {}
    for (const [topicId, usage] of confirmed) out[topicId] = { ...usage }
    for (const { topicId, output } of inflight.values()) {
      out[topicId] ??= zero(topicId)
      out[topicId].output += output
    }
    for (const usage of Object.values(out)) usage.output = Math.round(usage.output)
    return out
  }
  const publish = () => {
    const snapshot = totals()
    for (const listener of listeners) listener(snapshot)
  }

  // モデルの利用料以外（検索など）の費用を、モデルの利用料と同じ上限で数える
  function cost(taskId: string, costUsd: number, topicId?: string) {
    const total = (spent.get(taskId) ?? 0) + costUsd
    spent.set(taskId, total)
    if (topicId) {
      const sum = confirmed.get(topicId) ?? zero(topicId)
      confirmed.set(topicId, { ...sum, costUsd: sum.costUsd + costUsd })
      publish()
    }
    if (total >= limitUsd) halted = `課題 ${taskId} が費用の上限 ${limitUsd} に達しました`
  }

  async function* call({ topicId, taskId, context }: Call) {
    const live = { topicId, output: 0 }
    inflight.set(live, live)
    try {
      for await (const event of stream(context)) {
        if (event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta') {
          live.output += estimate(event.delta)
          publish()
        }
        if (event.type === 'done' || event.type === 'error') {
          const { usage } = event.type === 'done' ? event.message : event.error
          const sum = confirmed.get(topicId) ?? zero(topicId)
          confirmed.set(topicId, {
            topicId,
            input: sum.input + usage.input,
            output: sum.output + usage.output,
            cacheRead: sum.cacheRead + usage.cacheRead,
            costUsd: sum.costUsd + usage.cost.total,
          })
          inflight.delete(live)
          publish()
          const total = (spent.get(taskId) ?? 0) + usage.cost.total
          spent.set(taskId, total)
          if (total >= limitUsd) halted = `課題 ${taskId} が費用の上限 ${limitUsd} に達しました`
        }
        yield event
      }
    } finally {
      // 途中で切れた呼び出しの見積もりは合計から外す
      if (inflight.delete(live)) publish()
    }
  }

  // ponytail: 上限は呼ぶ前に確かめるため、最後の1回の分だけ超えうる。超過を許せなくなったら最大出力から見積もる
  async function handle(request: Request) {
    if (request.method !== 'POST') return Response.json({ error: 'POST で送ってください' }, { status: 405 })
    if (halted) return Response.json({ error: `停止中です: ${halted}` }, { status: 423 })
    const path = new URL(request.url).pathname
    if (path === '/cost') {
      const body = (await request.json().catch(() => null)) as Cost | null
      if (typeof body?.taskId !== 'string' || typeof body.costUsd !== 'number' || !(body.costUsd >= 0)) {
        return Response.json({ error: 'taskId と 0 以上の costUsd を送ってください' }, { status: 400 })
      }
      cost(body.taskId, body.costUsd, typeof body.topicId === 'string' ? body.topicId : undefined)
      return Response.json({ ok: true })
    }
    const body = (await request.json().catch(() => null)) as Call | null
    if (!body?.topicId || !body?.taskId || !Array.isArray(body.context?.messages)) {
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
    totals,
    // 課題1つあたりに使った費用（ドル）。ハーネスは保留の理由に使う
    spent: (taskId: string) => spent.get(taskId) ?? 0,
    limitUsd,
    // モデルの利用料以外の費用を足す。上限に達したら停止する
    cost,
    // 停止を解く。開始の合図を受けたときに呼ぶ
    resume: () => {
      halted = ''
    },
    subscribe(listener: (totals: Record<string, Usage>) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    halted: () => halted,
  }
}
