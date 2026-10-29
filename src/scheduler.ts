import type { Context } from "@earendil-works/chord";
import { AssistantEntry, type Conversation, type ConversationId, type Harness, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentDirectory, canClaimTask, type Role } from "./agents.ts";
import { TaskBoard, addTask, newTask, ready } from "./tasks.ts";
import { reconcileKnowledge } from "./workflow.ts";
import { AgentContext } from "./context/state.ts";
import { reconcileDomains } from "./domains.ts";
import { GoalStore } from "./goals.ts";
import { ORGANIZATION_LIMITS, OrganizationConflict, OrganizationDeferred, OrganizationStore } from "./organization.ts";
import { OrganizationExtension } from "./tools/organization.ts";

export async function runScheduler(harness: Harness, agents: Record<Role, Conversation>, context: Context, options: { maxRounds?: number; run?: (agent: Conversation, prompt: string) => Promise<void>; now?: () => number; organizationLimits?: Partial<typeof ORGANIZATION_LIMITS> } = {}) {
  const maxRounds = options.maxRounds ?? 20;
  const limits = { ...ORGANIZATION_LIMITS, ...options.organizationLimits };
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid organization limits");
  const runId = crypto.randomUUID();
  await harness.commit(async tx => { (await tx.doc(OrganizationStore)).run = { id: runId, round: 0, spawns: 0, roundSpawns: 0, roundChanges: 0, limits }; }, context);
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
    await harness.commit(async tx => { const run = (await tx.doc(OrganizationStore)).run; if (!run || run.id !== runId) throw new Error("Organization run superseded"); run.round = round; run.roundSpawns = 0; run.roundChanges = 0; }, context);
    await reconcileKnowledge(harness, context, options.now?.() ?? Date.now());
    await reconcileDomains(harness, context, options.now?.() ?? Date.now());
    const organization = await harness.snapshot(OrganizationStore, context);
    const approved = [...(organization?.proposals ?? []), ...(organization?.spawnProposals ?? []), ...(organization?.lifecycleProposals ?? []), ...(organization?.handoffs ?? [])].filter(p => p.status === "approved");
    const apply = OrganizationExtension.tools!.find(tool => tool.name === "organization_apply")!;
    for (const proposal of approved) {
      const api = { conversationId: agents.author.id, now: () => options.now?.() ?? Date.now(), commit: harness.commit.bind(harness) } as unknown as ToolExecutionApi;
      try { await apply.execute({ id: proposal.id }, api, context); }
      catch (error) {
        if (error instanceof OrganizationDeferred) continue;
        if (!(error instanceof OrganizationConflict)) throw error;
        await harness.commit(async tx => { const state = await tx.doc(OrganizationStore); const stale = [...state.proposals, ...(state.spawnProposals ?? []), ...(state.lifecycleProposals ?? []), ...(state.handoffs ?? [])].find(p => p.id === proposal.id && p.status === "approved"); if (stale) { stale.status = "rejected"; stale.review = `Reconciliation: ${error.message}`; stale.updatedAt = options.now?.() ?? Date.now(); if ("handoffStatus" in stale) { stale.handoffStatus = "failed"; stale.completedAt = stale.updatedAt; } } }, context);
      }
    }
    if (round < limits.maxOrganizationRounds) await harness.commit(async tx => {
      const board = await tx.doc(TaskBoard); const directory = await tx.doc(AgentDirectory); const organization = await tx.doc(OrganizationStore);
      for (const task of [...board.tasks]) {
        if (task.state !== "open" || task.type !== "subgoal" || !task.requiredSpecialty || !ready(board, task, options.now?.() ?? Date.now())) continue;
        const specialist = directory.agents?.find(agent => agent.status === "active" && agent.role.trim().toLowerCase() === task.requiredSpecialty!.trim().toLowerCase());
        if (specialist && canClaimTask(directory, task, Number(specialist.conversationId))) continue;
        if ((organization.spawnProposals ?? []).some(p => p.taskId === task.id && ["proposed", "under_review", "approved"].includes(p.status))) continue;
        const id = `organization-analysis:${task.id}:${task.revision}`;
        if (!board.tasks.some(t => t.id === id) && board.tasks.filter(t => t.type === "organization_analysis").length < 20) addTask(board, newTask({ id, type: "organization_analysis", description: task.id, role: "author" }, options.now?.() ?? Date.now()));
      }
    }, context);
    const board = await harness.snapshot(TaskBoard, context);
    const goals = await harness.snapshot(GoalStore, context);
    const directory = await harness.snapshot(AgentDirectory, context);
    const availableAgents = [...Object.values(agents)];
    for (const record of directory?.agents ?? []) {
      if (record.status !== "active" || availableAgents.some(a => String(a.id) === record.conversationId)) continue;
      const id = Number(record.conversationId);
      if (!Number.isSafeInteger(id) || id < 0 || String(id) !== record.conversationId) throw new Error("Invalid conversation ID");
      const agent = await harness.conversation(id as ConversationId, context); if (!agent) throw new Error(`Agent conversation missing: ${record.id}`);
      availableAgents.push(agent);
    }
    const priority = (type: string) => type === "organization_review" ? 2 : type === "organization_analysis" ? 1 : 0;
    const candidates = [...(board?.tasks ?? [])].sort((a, b) => priority(b.type) - priority(a.type));
    const available = candidates.find(task => {
      if (!board || !ready(board, task, options.now?.() ?? Date.now())) return false;
      if (!directory || !availableAgents.some(agent => canClaimTask(directory, task, agent.id))) return false;
      if (!task.goalId || task.type === "goal_plan") return true;
      const goal = goals?.goals.find(g => g.id === task.goalId);
      return goal?.status === "active" && goal.dependencies.every(id => goals?.goals.some(g => g.id === id && g.status === "completed"));
    });
    if (!available) return { status: board?.tasks.some(t => t.state === "claimed" || t.state === "open") ? "waiting" as const : "idle" as const, rounds: round };
    const agent = availableAgents.find(agent => canClaimTask(directory!, available, agent.id))!;
    const currentContext = await harness.snapshot(AgentContext, agent.id, context);
    const prompt = `現在の文脈バージョンは ${currentContext?.version ?? 0} です。タスク ${JSON.stringify(available)} を実行してください。まず task_claim を現在の revision と leaseMs=3600000、固有の operationId で呼んでください。取得できなければ作業せず終了してください。取得結果の token と revision を使ってください。review_source または review_gist の場合は knowledge_unfold で原資料を確認し、knowledge_review に id、stage、approved、reason、token、revision を渡してください。投稿タスクの場合は description をそのまま raw として、根拠付き summary と gist、taskId、token、revision を knowledge_propose に渡してください。この操作がタスクを完了します。domain_review または goal_review では提案を domain_proposal_list または goal_proposal_inspect で読み、独立に検証し、対応する review ツールで start と approve または reject を呼び、承認した場合は apply ツールを呼んでください。domain_analysis では domain_analyze で根拠とコストを検討し、必要な場合のみ提案してください。関連領域に根拠がある場合は domain_discover で未検証の仮説を探索してください。goal_plan では最上位目的との関係を説明できる下位目標を提案してください。subgoal は関連領域の知識を調べて実行し、完了後に goal_propose で完了を提案できます。hypothesis は未検証の仮説として扱い、task_finish 後に domain_discovery_feedback で成果と根拠を記録してください。discovery_feedback は description の発見 ID を domain_discovery_inspect で調べ、成果を記録してください。これらのタスクは作業後 task_finish で完了してください。各操作の operationId は重複しない値にしてください。`;
    const isBase = Object.values(directory!.ids).includes(agent.id);
    await run(agent, isBase ? prompt + " organization_review の場合は organization_status で提案を読み、applied または rejected なら task_finish、approved なら organization_apply 後に task_finish、それ以外は organization_review で start と approve または reject を行い、承認した場合は organization_apply を呼んでから task_finish してください。organization_analysis の場合は organization_analyze と agent_list、task_status で対象を調べ、現状維持、既存エージェントへの引き継ぎ、休眠からの復帰を優先してください。既存エージェントを使えず専門性が必要な場合のみ organization_propose を呼び、理由と費用とリスクを記録してください。分析結果を task_finish で記録してください。" : `現在の文脈バージョンは ${currentContext?.version ?? 0} です。過去の作業記憶は最新とは限りません。必要な目標・領域・共有知識を照合してください。タスク ${JSON.stringify(available)} を実行してください。task_claim で取得し、共有知識を調べて、domain_analysis では domain_analyze も実行し、結果を task_finish で記録してください。`);
  }
  await reconcileKnowledge(harness, context, options.now?.() ?? Date.now());
  return { status: "round_limit" as const, rounds: maxRounds };
}
