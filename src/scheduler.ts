import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { Role } from "./agents.ts";
import { TaskBoard, ready } from "./tasks.ts";
import { reconcileKnowledge } from "./workflow.ts";
import { AgentContext } from "./context/state.ts";

export async function runScheduler(harness: Harness, agents: Record<Role, Conversation>, context: Context, options: { maxRounds?: number; run?: (agent: Conversation, prompt: string) => Promise<void>; now?: () => number } = {}) {
  const maxRounds = options.maxRounds ?? 20;
  const run = options.run ?? (async (agent, prompt) => {
    const submission = await agent.submit({ type: "input", content: prompt }, context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { void agent.abort(context).catch(() => {}); reject(new Error(`Agent ${agent.id} timed out`)); }, 120_000);
    });
    const settled = await Promise.race([submission.wait(context), timeout]).finally(() => clearTimeout(timer));
    if (settled.status !== "done" || settled.type !== "input") throw new Error(`Agent ${agent.id} did not finish`);
    await agent.commit(tx => tx.entry(AssistantEntry, settled.answer), context);
  });
  for (let round = 0; round < maxRounds; round++) {
    await reconcileKnowledge(harness, context, options.now?.() ?? Date.now());
    const board = await harness.snapshot(TaskBoard, context);
    const available = board?.tasks.find(task => ready(board, task, options.now?.() ?? Date.now()));
    if (!available) return { status: board?.tasks.some(t => t.state === "claimed") ? "waiting" as const : "idle" as const, rounds: round };
    const currentContext = await harness.snapshot(AgentContext, agents[available.role].id, context);
    const prompt = `現在の文脈バージョンは ${currentContext?.version ?? 0} です。タスク ${JSON.stringify(available)} を実行してください。まず task_claim を現在の revision と leaseMs=3600000、固有の operationId で呼んでください。取得できなければ作業せず終了してください。取得結果の token と revision を使ってください。review_source または review_gist の場合は knowledge_unfold で原資料を確認し、knowledge_review に id、stage、approved、reason、token、revision を渡してください。投稿タスクの場合は description をそのまま raw として、根拠付き summary と gist、taskId、token、revision を knowledge_propose に渡してください。この操作がタスクを完了します。各操作の operationId は重複しない値にしてください。`;
    await run(agents[available.role], prompt);
  }
  await reconcileKnowledge(harness, context, options.now?.() ?? Date.now());
  return { status: "round_limit" as const, rounds: maxRounds };
}
