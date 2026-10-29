import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FileCredentialStore } from "./auth.ts";
import { AgentPermissionExtension, restoreAgents } from "./agents.ts";
import { MemoryExtension } from "./tools/memory.ts";
import { KnowledgeExtension } from "./tools/knowledge.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { runScheduler } from "./scheduler.ts";
import { AgentContext, DEFAULT_BUDGET } from "./context/state.ts";
import { createContextExtension } from "./context/extension.ts";
import { syncMirror } from "./context/mirror.ts";
import { DomainExtension } from "./tools/domains.ts";
import { GoalExtension } from "./tools/goals.ts";
import { OrganizationExtension } from "./tools/organization.ts";
import { DomainStore, DEFAULT_DOMAIN, reconcileDomains } from "./domains.ts";
import { GoalStore, initializeGlobalGoal } from "./goals.ts";

const credentials = await FileCredentialStore.open();
const models = createModels({ credentials });
models.setProvider(openaiProvider());
const modelId = process.env.OPENAI_MODEL ?? "gpt-6-sol";
const maxTokens = Number(process.env.CLM_MAX_TOKENS ?? DEFAULT_BUDGET.maxTokens);
if (!Number.isSafeInteger(maxTokens) || maxTokens <= DEFAULT_BUDGET.reserveTokens + DEFAULT_BUDGET.keepRecentTokens) throw new Error("Invalid CLM_MAX_TOKENS");
if (!(await models.getAuth("openai"))) throw new Error("ChatGPTでのログインが必要です");
if (!models.getModel("openai", modelId)) throw new Error(`未対応のモデル: ${modelId}`);
const registry = createRegistry();
registry.install(AgentPermissionExtension);
registry.install(MemoryExtension);
registry.install(KnowledgeExtension);
registry.install(TaskExtension);
registry.install(DomainExtension);
registry.install(GoalExtension);
registry.install(OrganizationExtension);
let requestCount = 0;
registry.install(defineExtension({ name: "delm-request-limit", hooks: [hook(GenerationTask, {
  beforeRequest: () => {
    if (++requestCount > 200) throw new Error("Model request limit reached");
  },
})] }));
const storage = await openNodeSqliteStorage("./session.sqlite");
const harness = await Harness.open(storage, { models, registry, settings: { stream: { maxRetries: 0 } } }, context);
registry.install(createContextExtension(harness));
try {
  const agents = await restoreAgents(harness, context);
  await reconcileDomains(harness, context);
  const args = process.argv.slice(2);
  const goalIndex = args.indexOf("--goal");
  if (goalIndex !== -1) {
    const goal = args[goalIndex + 1];
    if (!goal) throw new Error("--goal requires a value");
    await initializeGlobalGoal(harness, goal, context);
    args.splice(goalIndex, 2);
  }
  const goals = await harness.snapshot(GoalStore, context);
  const globalGoal = goals?.goals.find(g => g.id === goals.globalId);
  if (globalGoal) await harness.commit(async tx => {
    const domains = await tx.doc(DomainStore); const domain = domains.domains.find(d => d.id === DEFAULT_DOMAIN && d.status === "active") ?? domains.domains.find(d => d.status === "active");
    if (domain && !domain.goalIds.includes(globalGoal.id)) { domain.goalIds.push(globalGoal.id); domain.revision++; domain.updatedAt = Date.now(); }
    const board = await tx.doc(TaskBoard);
    if (!board.tasks.some(t => t.id === "goal:initial-plan")) addTask(board, newTask({ id: "goal:initial-plan", type: "goal_plan", description: globalGoal.description, role: "author", goalId: globalGoal.id }, Date.now()));
  }, context);
  for (const [role, agent] of Object.entries(agents)) {
    const existing = await harness.snapshot(AgentContext, agent.id, context);
    if (!existing) await harness.commit(async tx => { (await tx.doc(AgentContext, agent.id)).budget.maxTokens = maxTokens; }, context);
    await syncMirror(harness, agent.id, context);
    await agent.configure({ model: { provider: "openai", modelId }, thinkingLevel: "high", instructions: `あなたの役割は ${role} です。最上位目的: ${globalGoal?.description ?? "未設定"}。この目的は変更できません。共有タスクを取得してから処理してください。原資料のない情報を追加せず、検証では根拠を確認してください。文脈は context_read、context_edit、context_history、context_restore、context_checkpoint で管理してください。領域と下位目標の変更は独立した検証を経てください。` }, context);
  }
  const raw = args.join(" ").trim();
  if (raw) await harness.commit(async tx => {
    const board = await tx.doc(TaskBoard);
    const id = `author:${crypto.randomUUID()}`;
    addTask(board, newTask({ id, type: "propose", description: raw, role: "author" }, Date.now()));
  }, context);
  console.log(await runScheduler(harness, agents, context));
} finally {
  await harness.close(context);
}
