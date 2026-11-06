// モデルの呼び出しの記録から、エージェントのやり取りの図（会話ごとの列と、委任の矢印）を組み立てる。
// 1回の呼び出しは、それまでの会話（context）と応答（reply）を持つ。同じ会話の呼び出しは最初のメッセージが同じ

type Block = {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  arguments?: Record<string, unknown>
}
export type Message = {
  role: string
  content: string | Block[]
  toolCallId?: string
  toolName?: string
  isError?: boolean
}
export type Call = {
  context: { systemPrompt?: string; messages: Message[] }
  reply: Message
}
export type Step = {
  id: string
  lane: number
  kind: 'goal' | 'assistant' | 'tool' | 'result'
  title: string
  text: string
  error?: boolean
}
export type Edge = {
  from: string
  to: string
  kind: 'next' | 'delegate' | 'return'
}
export type Graph = { lanes: number; steps: Step[]; edges: Edge[] }

const textOf = (m: Message) =>
  typeof m.content === 'string'
    ? m.content
    : m.content
        .map((b) => b.text ?? b.thinking ?? JSON.stringify(b.arguments ?? ''))
        .join('\n')

export function buildGraph(calls: Call[]): Graph {
  // 会話ごとにメッセージを集める。古いツールの結果は文脈の圧縮で短い参照に置き換わるため、位置ごとに最も長いものを残す
  const conversations = new Map<string, Message[]>()
  for (const call of calls) {
    const messages = [...call.context.messages, call.reply]
    const key = `${call.context.systemPrompt ?? ''}\0${textOf(messages[0])}`
    const kept = conversations.get(key) ?? []
    messages.forEach((m, i) => {
      if (!kept[i] || textOf(m).length > textOf(kept[i]).length) kept[i] = m
    })
    conversations.set(key, kept)
  }
  const steps: Step[] = []
  const edges: Edge[] = []
  const firstOf: { lane: number; text: string; id: string }[] = []
  const lastOf = new Map<number, string>()
  const calledBy = new Map<string, string>()
  const resultOf = new Map<string, string>()
  const delegations: { from: string; goal: string; call: string }[] = []
  ;[...conversations.values()].forEach((messages, lane) => {
    let previous: string | null = null
    const push = (step: Omit<Step, 'id' | 'lane'>) => {
      const id = `${lane}-${steps.length}`
      steps.push({ id, lane, ...step })
      if (previous) edges.push({ from: previous, to: id, kind: 'next' })
      previous = id
      return id
    }
    messages.forEach((m, i) => {
      if (m.role === 'user') {
        const id = push({
          kind: 'goal',
          title: i === 0 ? (lane === 0 ? '課題' : '部分目的') : '指示',
          text: textOf(m),
        })
        if (i === 0) firstOf.push({ lane, text: textOf(m), id })
      } else if (m.role === 'toolResult') {
        const id = push({
          kind: 'result',
          title: `${m.toolName ?? 'ツール'} の結果`,
          text: textOf(m),
          error: m.isError,
        })
        if (m.toolCallId) resultOf.set(m.toolCallId, id)
      } else if (m.role === 'assistant' && typeof m.content !== 'string') {
        const words = m.content
          .filter((b) => b.type === 'text' || b.type === 'thinking')
          .map((b) =>
            b.type === 'thinking'
              ? `（思考）${b.thinking ?? ''}`
              : (b.text ?? ''),
          )
          .join('\n')
          .trim()
        if (words) push({ kind: 'assistant', title: 'モデル', text: words })
        for (const b of m.content.filter((b) => b.type === 'toolCall')) {
          const args = b.arguments ?? {}
          const id = push({
            kind: 'tool',
            title: b.name ?? 'ツール',
            text:
              typeof args.command === 'string'
                ? args.command
                : JSON.stringify(args, null, 2),
          })
          if (b.id) calledBy.set(b.id, id)
          if (b.name === 'delegate' && typeof args.goal === 'string' && b.id) {
            delegations.push({ from: id, goal: args.goal, call: b.id })
          }
        }
      }
    })
    if (previous) lastOf.set(lane, previous)
  })
  // 委任: 親の delegate から、その部分目的で始まる子の会話へ矢印を引き、子の最後から親の結果へ戻す
  for (const d of delegations) {
    const child = firstOf.find((f) => f.lane !== 0 && f.text.startsWith(d.goal))
    if (!child) continue
    edges.push({ from: d.from, to: child.id, kind: 'delegate' })
    const last = lastOf.get(child.lane)
    const back = resultOf.get(d.call)
    if (last && back) edges.push({ from: last, to: back, kind: 'return' })
  }
  return { lanes: conversations.size, steps, edges }
}
