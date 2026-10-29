import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { FileCredentialStore } from "./auth.ts";
import { restoreAgents } from "./agents.ts";
import { MemoryExtension } from "./tools/memory.ts";
import { KnowledgeExtension } from "./tools/knowledge.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { runScheduler } from "./scheduler.ts";

const credentials = await FileCredentialStore.open();
const models = createModels({ credentials });
models.setProvider(openaiProvider());
const modelId = process.env.OPENAI_MODEL ?? "gpt-6-sol";
if (!(await models.getAuth("openai"))) throw new Error("ChatGPTでのログインが必要です");
if (!models.getModel("openai", modelId)) throw new Error(`未対応のモデル: ${modelId}`);
const registry = createRegistry();
registry.install(MemoryExtension);
registry.install(KnowledgeExtension);
registry.install(TaskExtension);
let requestCount = 0;
registry.install(defineExtension({ name: "delm-request-limit", hooks: [hook(GenerationTask, {
  beforeRequest: () => {
    if (++requestCount > 200) throw new Error("Model request limit reached");
  },
})] }));
const storage = await openNodeSqliteStorage("./session.sqlite");
const harness = await Harness.open(storage, { models, registry, settings: { stream: { maxRetries: 0 } } }, context);
try {
  const agents = await restoreAgents(harness, context);
  for (const [role, agent] of Object.entries(agents)) {
    await agent.configure({ model: { provider: "openai", modelId }, thinkingLevel: "high", instructions: `あなたの役割は ${role} です。共有タスクを取得してから処理してください。原資料のない情報を追加せず、検証では根拠を確認してください。` }, context);
  }
  const raw = process.argv.slice(2).join(" ").trim();
  if (raw) await harness.commit(async tx => {
    const board = await tx.doc(TaskBoard);
    const id = `author:${crypto.randomUUID()}`;
    addTask(board, newTask({ id, type: "propose", description: raw, role: "author" }, Date.now()));
  }, context);
  console.log(await runScheduler(harness, agents, context));
} finally {
  await harness.close(context);
}
