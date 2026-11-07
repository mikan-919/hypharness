// 子プロセスとして動く改良の対象が、対話の状態に触れる受け口（固定部、ADR 0022）。
// 約束（shared/contract.ts の AgentStore）にある操作だけを受け付ける
import type { Store } from './store.ts'

export function serveHost(store: Store, socket: string) {
  const ops: Record<string, (...args: any[]) => unknown> = {
    snapshot: () => store.snapshot(),
    act: (agent, kind, text) => store.act(agent, kind, text),
    setLive: (agent, text) => store.setLive(agent, String(text).slice(-600)),
    record: (entry) => store.record(entry),
    setTopic: (id, patch) => store.setTopic(id, patch),
    setSeen: (topicId, version) => store.setSeen(topicId, version),
    saveTranscript: (topicId, messages) => store.saveTranscript(topicId, messages),
    transcript: (topicId) => store.transcript(topicId) ?? null,
    seen: (topicId) => store.seen(topicId),
    editsSince: (since, author) => store.editsSince(since, author),
    editGoal: (text, base, author, reason) => store.editGoal(text, base, author, reason),
    // 質問を待ち行列に入れて id を返す。答えは answerOf で見に行く（長く待つ要求は接続が打ち切られるため）
    askStart: (question) => {
      void store.ask(question)
      return store.snapshot().questions.find((q) => q.key === question.key)?.id ?? ''
    },
    answerOf: (id) => store.snapshot().questions.find((q) => q.id === id)?.answer ?? '',
  }
  return Bun.serve({
    unix: socket,
    async fetch(request) {
      const body = (await request.json().catch(() => null)) as { op: string; args: unknown[] } | null
      const op = body && ops[body.op]
      if (!op || !Array.isArray(body.args)) return Response.json({ error: `受け付けない操作です: ${body?.op}` }, { status: 400 })
      try {
        return Response.json({ result: (await op(...body.args)) ?? null })
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 })
      }
    },
  })
}
