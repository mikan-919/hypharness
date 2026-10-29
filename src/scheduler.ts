import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Conversation, type Harness } from "@earendil-works/pi-durable";
import type { Role } from "./agents.ts";
import { TaskBoard, ready } from "./tasks.ts";
import { reconcileKnowledge } from "./workflow.ts";
import { AgentContext } from "./context/state.ts";
import { reconcileDomains } from "./domains.ts";
import { GoalStore } from "./goals.ts";

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
    await reconcileDomains(harness, context, options.now?.() ?? Date.now());
    const board = await harness.snapshot(TaskBoard, context);
    const goals = await harness.snapshot(GoalStore, context);
    const available = board?.tasks.find(task => {
      if (!ready(board, task, options.now?.() ?? Date.now())) return false;
      if (!task.goalId || task.type === "goal_plan") return true;
      const goal = goals?.goals.find(g => g.id === task.goalId);
      return goal?.status === "active" && goal.dependencies.every(id => goals?.goals.some(g => g.id === id && g.status === "completed"));
    });
    if (!available) return { status: board?.tasks.some(t => t.state === "claimed" || t.state === "open") ? "waiting" as const : "idle" as const, rounds: round };
    const currentContext = await harness.snapshot(AgentContext, agents[available.role].id, context);
    const prompt = `現在の文脈バージョンは ${currentContext?.version ?? 0} です。タスク ${JSON.stringify(available)} を実行してください。まず task_claim を現在の revision と leaseMs=3600000、固有の operationId で呼んでください。取得できなければ作業せず終了してください。取得結果の token と revision を使ってください。review_source または review_gist の場合は knowledge_unfold で原資料を確認し、knowledge_review に id、stage、approved、reason、token、revision を渡してください。投稿タスクの場合は description をそのまま raw として、根拠付き summary と gist、taskId、token、revision を knowledge_propose に渡してください。この操作がタスクを完了します。domain_review または goal_review では提案を domain_proposal_list または goal_proposal_inspect で読み、独立に検証し、対応する review ツールで start と approve または reject を呼び、承認した場合は apply ツールを呼んでください。domain_analysis では domain_analyze で根拠とコストを検討し、必要な場合のみ提案してください。関連領域に根拠がある場合は domain_discover で未検証の仮説を探索してください。goal_plan では最上位目的との関係を説明できる下位目標を提案してください。subgoal は関連領域の知識を調べて実行し、完了後に goal_propose で完了を提案できます。hypothesis は未検証の仮説として扱い、task_finish 後に domain_discovery_feedback で成果と根拠を記録してください。discovery_feedback は description の発見 ID を domain_discovery_inspect で調べ、成果を記録してください。これらのタスクは作業後 task_finish で完了してください。各操作の operationId は重複しない値にしてください。`;
    await run(agents[available.role], prompt);
  }
  await reconcileKnowledge(harness, context, options.now?.() ?? Date.now());
  return { status: "round_limit" as const, rounds: maxRounds };
}
