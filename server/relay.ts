// モデルの呼び出しの中継（固定部、ADR 0014）。ハーネスはこの Unix ソケットからだけモデルを呼ぶ。
// 費用の記録・課題1つあたりの上限・停止（ADR 0011、0012）と、トークン数の配信（ADR 0016）を持つ
import type { AssistantMessageEvent, Context } from '@earendil-works/pi-ai'
import type { TaskUsage, Usage } from '../shared/dialog.ts'

// sessionId は会話ごとに固定した値。OpenCode Go は x-opencode-session として受け取り、経路とキャッシュに使う（ADR 0044）
export type Stream = (context: Context, sessionId?: string) => AsyncIterable<AssistantMessageEvent>
export type Call = { topicId: string; taskId: string; context: Context }
export type Cost = { topicId?: string; taskId: string; costUsd: number }

// ストリーミング中の出力トークン数の見積もり。DeepSeek V4.1 Flash の応答で測った値（2026-11-06）で、
// ASCII は1文字 0.23、それ以外（日本語など）は1文字 1.1 トークン。応答が終わったら実際の数に置き換える
const estimate = (text: string) => {
  let tokens = 0
  for (const c of text) tokens += c.charCodeAt(0) < 128 ? 0.23 : 1.1
  return tokens
}

const HEARTBEAT_MS = 5_000

const zero = (topicId: string): Usage => ({ topicId, input: 0, output: 0, cacheRead: 0, costUsd: 0 })

// onTask には、呼び出しが終わるたびに、その課題のそれまでの記録を渡す
export function createRelay(stream: Stream, limitUsd: number, onTask?: (taskId: string, usage: TaskUsage) => void) {
  const spent = new Map<string, number>()
  // ponytail: 課題の記録は taskId だけで分ける。別のリポジトリで同じ id の課題を動かすと、サーバーを起動し直すまで足し合わさる
  const tasks = new Map<string, TaskUsage>()
  // エージェントと課題ごとの、前の呼び出しの会話の件数。減ったら作り直したと数える
  const lengths = new Map<string, number>()
  // 会話の id の接頭辞。起動ごとに変え、別の起動の同じ課題 id と混ざらないようにする
  const run = crypto.randomUUID().slice(0, 8)
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
    const key = `${topicId}/${taskId}`
    const rebuilt = context.messages.length < (lengths.get(key) ?? 0)
    lengths.set(key, context.messages.length)
    try {
      for await (const event of stream(context, `hypharness-${run}-${topicId}-${taskId}`)) {
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
          const record = tasks.get(taskId) ?? { calls: 0, input: 0, cacheRead: 0, output: 0, maxPrompt: 0, edits: 0, rebuilds: 0, costUsd: 0 }
          const content = event.type === 'done' ? event.message.content : []
          const next = {
            calls: record.calls + 1,
            input: record.input + usage.input,
            cacheRead: record.cacheRead + usage.cacheRead,
            output: record.output + usage.output,
            maxPrompt: Math.max(record.maxPrompt, usage.input + usage.cacheRead + usage.cacheWrite),
            edits: record.edits + content.filter((c) => c.type === 'toolCall' && c.name === 'edit_context').length,
            rebuilds: record.rebuilds + (rebuilt ? 1 : 0),
            costUsd: record.costUsd + usage.cost.total,
          }
          tasks.set(taskId, next)
          onTask?.(taskId, next)
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
    // モデルが最初のトークンを返すまでに 10 秒以上かかることがあり、Bun.serve は 10 秒流れない接続を切る。
    // 待っている間は 5 秒ごとに空行を流して接続を保つ。受け取る側は空行を読み飛ばす
    let next: Promise<IteratorResult<AssistantMessageEvent>> | undefined
    // 1行に1つのイベントを JSON で流す。partial は応答の途中の全文で大きいため送らない
    return new Response(
      new ReadableStream({
        async pull(controller) {
          next ??= events.next()
          const result = await Promise.race([next, Bun.sleep(HEARTBEAT_MS).then(() => undefined)])
          if (!result) return controller.enqueue(encoder.encode('\n'))
          next = undefined
          const { value, done } = result
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
    // 固定部の中から中継を通してモデルを呼ぶ。費用は taskId に数える
    stream: (topicId: string, taskId: string): Stream => (context) => call({ topicId, taskId, context }),
  }
}
