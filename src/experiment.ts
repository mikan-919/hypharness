import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCredentialStore } from "./auth.ts";
import { AgentDirectory, AgentPermissionExtension, restoreAgents } from "./agents.ts";
import { AgentContext, estimate } from "./context/state.ts";
import { createContextExtension } from "./context/extension.ts";
import { DomainExtension } from "./tools/domains.ts";
import { GoalExtension } from "./tools/goals.ts";
import { KnowledgeExtension } from "./tools/knowledge.ts";
import { MemoryExtension } from "./tools/memory.ts";
import { OrganizationExtension } from "./tools/organization.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { initializeGlobalGoal } from "./goals.ts";
import { DomainStore, reconcileDomains } from "./domains.ts";
import { OrganizationStore } from "./organization.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { runScheduler } from "./scheduler.ts";

export type OrganizationMetrics = {
  activeAgents: number; spawnedAgents: number; resumedAgents: number; retiredAgents: number;
  tasksCompleted: number; tasksFailed: number; totalModelCalls: number;
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  organizationChanges: number; elapsedMs: number; requestContextBytes: number; retainedContextBytes: number;
};

export function parseExperimentArgs(args: string[]): { goal: string; tasks: string[] } {
  let goal = ""; const tasks: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i], value = args[++i];
    if ((flag !== "--goal" && flag !== "--task") || !value?.trim() || value.startsWith("--")) throw new Error("Usage: bun run experiment --goal GOAL --task TASK [--task TASK ...]");
    if (flag === "--goal") { if (goal) throw new Error("Only one goal is allowed"); goal = value; } else tasks.push(value);
  }
  if (!goal || !tasks.length) throw new Error("Usage: bun run experiment --goal GOAL --task TASK [--task TASK ...]");
  return { goal, tasks };
}

async function runExperiment(goal: string, tasks: string[], dynamic: boolean): Promise<OrganizationMetrics> {
  const credentials = await FileCredentialStore.open(); const models = createModels({ credentials }); models.setProvider(openaiProvider());
  const modelId = process.env.OPENAI_MODEL ?? "gpt-6-sol";
  if (!(await models.getAuth("openai")) || !models.getModel("openai", modelId)) throw new Error("OpenAI credentials or model unavailable");
  const registry = createRegistry();
  for (const extension of [AgentPermissionExtension, MemoryExtension, KnowledgeExtension, TaskExtension, DomainExtension, GoalExtension, OrganizationExtension]) registry.install(extension);
  let calls = 0, requestContextBytes = 0;
  registry.install(defineExtension({ name: "experiment-budget", hooks: [hook(GenerationTask, { beforeRequest: request => { if (++calls > 200) throw new Error("Model request limit reached"); requestContextBytes += estimate(request.messages); } })] }));
  const mirror = await mkdtemp(join(tmpdir(), "delm-comparison-"));
  const harness = await Harness.open(new MemoryStorage(), { models, registry, settings: { stream: { maxRetries: 0 } } }, context);
  registry.install(createContextExtension(harness, mirror));
  const started = performance.now();
  try {
    const agents = await restoreAgents(harness, context); await initializeGlobalGoal(harness, goal, context); await reconcileDomains(harness, context);
    await harness.commit(async tx => {
      const domains = await tx.doc(DomainStore); const domain = domains.domains.find(d => d.status === "active"); if (domain && !domain.goalIds.includes("goal:global")) { domain.goalIds.push("goal:global"); domain.revision++; }
      const board = await tx.doc(TaskBoard); for (const [index, description] of tasks.entries()) addTask(board, newTask({ id: `experiment:${index}`, type: "subgoal", role: "author", description, goalId: "goal:global" }, Date.now()));
    }, context);
    for (const [role, agent] of Object.entries(agents)) {
      await harness.commit(async tx => { await tx.doc(AgentContext, agent.id); }, context);
      await agent.configure({ model: { provider: "openai", modelId }, thinkingLevel: "high", instructions: `あなたの役割は ${role} です。最上位目的: ${goal}。この目的は変更できません。共有タスクを取得してから処理してください。原資料のない情報を追加せず、検証では根拠を確認してください。` }, context);
    }
    await runScheduler(harness, agents, context, { organizationLimits: { maxActiveAgents: dynamic ? 6 : 3 } });
    const board = await harness.snapshot(TaskBoard, context); const directory = await harness.snapshot(AgentDirectory, context); const org = await harness.snapshot(OrganizationStore, context);
    const selected = (board?.tasks ?? []).filter(t => t.id.startsWith("experiment:"));
    const spawns = (org?.spawnProposals ?? []).filter(p => p.status === "applied"); const lifecycle = (org?.lifecycleProposals ?? []).filter(p => p.status === "applied"); const handoffs = (org?.handoffs ?? []).filter(p => p.status === "applied");
    let retainedContextBytes = 0;
    for (const agent of directory?.agents ?? []) { const id = Number(agent.conversationId); if (!Number.isSafeInteger(id) || String(id) !== agent.conversationId) throw new Error("Invalid conversation ID"); const state = await harness.snapshot(AgentContext, id as ConversationId, context); if (state) retainedContextBytes += estimate(state.workingMemory) + estimate(state.checkpoint.summary); }
    // pi-ai normalizes absent provider usage fields to zero, so exact availability cannot be recovered here.
    return { activeAgents: (directory?.agents ?? []).filter(a => a.status === "active").length, spawnedAgents: spawns.length, resumedAgents: lifecycle.filter(p => p.kind === "reuse").length, retiredAgents: lifecycle.filter(p => p.kind === "retire").length + handoffs.filter(p => p.kind === "consolidate").length, tasksCompleted: selected.filter(t => t.state === "completed").length, tasksFailed: selected.filter(t => t.state === "failed").length, totalModelCalls: calls, inputTokens: null, outputTokens: null, cachedInputTokens: null, organizationChanges: spawns.length + lifecycle.length + handoffs.length + (org?.proposals ?? []).filter(p => p.status === "applied").length, elapsedMs: performance.now() - started, requestContextBytes, retainedContextBytes };
  } finally { await harness.close(context); await rm(mirror, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const { goal, tasks } = parseExperimentArgs(process.argv.slice(2));
  const fixed = await runExperiment(goal, tasks, false); const dynamic = await runExperiment(goal, tasks, true);
  console.log(JSON.stringify({ taskCount: tasks.length, fixed, dynamic }, null, 2));
}
