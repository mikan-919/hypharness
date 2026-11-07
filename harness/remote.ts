// 子プロセスから、固定部の対話の状態を約束（AgentStore）の形で使う（ADR 0022）
import type { AgentStore } from '../shared/contract.ts'

const POLL_MS = 1000
const LIVE_MS = 250

export function remoteStore(socket: string) {
  const rpc = async (op: string, ...args: unknown[]) => {
    const response = await fetch('http://host/', { unix: socket, method: 'POST', body: JSON.stringify({ op, args }) })
    const body = (await response.json()) as { result?: any; error?: string }
    if (!response.ok) throw new Error(body.error ?? `${op} に失敗しました`)
    return body.result
  }
  // 値を返さない操作は順に送り、待たない。値を返す操作は、それまでに送った操作が届いてから送る
  let queue: Promise<unknown> = Promise.resolve()
  const send = (op: string, ...args: unknown[]) => {
    queue = queue.then(() => rpc(op, ...args)).catch((e) => console.error(e))
  }
  const ask = async (op: string, ...args: unknown[]) => {
    await queue
    return rpc(op, ...args)
  }
  // 書いている途中の文は、250 ミリ秒に1回、エージェントごとに最新のものだけを送る
  const live = new Map<string, string>()
  let liveTimer: ReturnType<typeof setTimeout> | undefined
  const setLive = (agent: string, text: string) => {
    live.set(agent, text)
    liveTimer ??= setTimeout(() => {
      liveTimer = undefined
      for (const [a, t] of live) send('setLive', a, t)
      live.clear()
    }, LIVE_MS)
  }

  const store: AgentStore & { flush(): Promise<unknown> } = {
    act: (agent, kind, text) => send('act', agent, kind, text),
    setLive,
    record: (entry) => send('record', entry),
    setTopic: (id, patch) => send('setTopic', id, patch),
    setSeen: (topicId, version) => send('setSeen', topicId, version),
    saveTranscript: (topicId, messages) => send('saveTranscript', topicId, messages),
    snapshot: () => ask('snapshot'),
    editGoal: (text, base, author, reason) => ask('editGoal', text, base, author, reason),
    transcript: async (topicId) => (await ask('transcript', topicId)) ?? undefined,
    seen: (topicId) => ask('seen', topicId),
    editsSince: (since, author) => ask('editsSince', since, author),
    async ask(question) {
      const id = await ask('askStart', question)
      while (true) {
        const answer = await rpc('answerOf', id)
        if (answer) return answer
        await Bun.sleep(POLL_MS)
      }
    },
    // 終わる前に、送っていない操作を送り切る
    flush: async () => {
      if (liveTimer) {
        clearTimeout(liveTimer)
        liveTimer = undefined
        for (const [a, t] of live) send('setLive', a, t)
      }
      return queue
    },
  }
  return store
}
