import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type HookApi, type ToolHookCall, type ToolHooks, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDirectory, AgentPermissionExtension, canClaimTask, canUseTool, restoreAgents, type AgentRecord } from "./agents.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { OrganizationExtension } from "./tools/organization.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { runScheduler } from "./scheduler.ts";

test("dynamic permissions are bound to the registered conversation and deny unknown capabilities", () => {
  const agent: AgentRecord = { id: "dynamic", conversationId: "42", name: "researcher", role: "researcher", capabilities: ["research"], status: "active", domainIds: [], goalIds: [], parentAgentId: null, createdAt: 0, updatedAt: 0, lastActiveAt: null, revision: 0 };
  const directory = { ids: {}, agents: [agent] };
  expect(canUseTool(directory, 42, "knowledge_search")).toBe(true);
  expect(canUseTool(directory, 42, "organization_review")).toBe(false);
  expect(canUseTool(directory, 43, "knowledge_search")).toBe(false);
  expect(canClaimTask(directory, { role: "author", assignedAgentId: agent.id }, 42)).toBe(false);
  agent.capabilities.push("unknown_permission");
  expect(canUseTool(directory, 42, "organization_review")).toBe(false);
  agent.capabilities.push("task_management");
  expect(canClaimTask(directory, { role: "author", assignedAgentId: agent.id }, 42)).toBe(true);
  agent.status = "draining";
  expect(canClaimTask(directory, { role: "author", assignedAgentId: agent.id }, 42)).toBe(false);
});

test("tool hook blocks unregistered and unauthorized conversations", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context);
    const hook = AgentPermissionExtension.hooks![0]!.handlers as ToolHooks;
    const api = { conversationId: agents.author.id, snapshot: harness.snapshot.bind(harness) } as unknown as HookApi;
    const call = { name: "knowledge_search" } as ToolHookCall;
    expect(await hook.beforeTool(call, api, context)).toBeUndefined();
    const missing = { ...api, conversationId: 999999 as typeof agents.author.id } as HookApi;
    expect(await hook.beforeTool(call, missing, context)).toEqual({ block: "Agent is not authorized to use this tool" });
  } finally { await harness.close(context); }
});

test("delegation requires independent approval, preserves claims, and assigns a new token", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context);
    await harness.commit(async tx => { addTask(await tx.doc(TaskBoard), newTask({ id: "work", type: "subgoal", role: "author", description: "work" }, 0)); }, context);
    const call = async (name: string, args: Record<string, unknown>, agent = agents.author, callId = name) => {
      const tool = [...OrganizationExtension.tools!, ...TaskExtension.tools!].find(t => t.name === name)!;
      const api = { conversationId: agent.id, callId, now: () => 1000, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
      const result = await tool.execute(args, api, context);
      const item = result.output?.[0]; return item?.type === "text" ? JSON.parse(item.text) : null;
    };
    const first = await call("task_claim", { id: "work", revision: 0, leaseMs: 1000, operationId: "claim" });
    const target = (await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.role === "source_reviewer")!;
    const draft = { taskId: "work", taskRevision: first.revision, targetAgentId: target.id, targetRevision: target.revision, reason: "handoff", benefits: "capacity", risks: "coordination" };
    await expect(call("agent_delegate", draft)).rejects.toThrow("Task unavailable");
    await call("task_release", { id: "work", token: first.token, revision: first.revision, operationId: "release" });
    const proposal = await call("agent_delegate", { ...draft, taskRevision: 2 });
    await expect(call("organization_apply", { id: proposal })).rejects.toThrow("Independent approval required");
    await expect(call("organization_review", { id: proposal, decision: "start", reason: "review" })).rejects.toThrow("Independent reviewer required");
    await call("organization_review", { id: proposal, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("organization_review", { id: proposal, decision: "approve", reason: "review" }, agents.source_reviewer);
    expect(await call("organization_apply", { id: proposal })).toBe("applied");
    expect(await call("organization_apply", { id: proposal })).toBe("applied");
    await expect(call("task_claim", { id: "work", revision: 3, leaseMs: 1000, operationId: "old" })).rejects.toThrow("Task unavailable");
    const next = await call("task_claim", { id: "work", revision: 3, leaseMs: 1000, operationId: "new" }, agents.source_reviewer);
    expect(next.token).not.toBe(first.token);
    expect(next.owner).toBe(String(agents.source_reviewer.id));
    const analysis = await call("organization_analyze", {});
    expect(analysis.activeAgents).toBe(3);
    expect(analysis.agents.find((a: { id: string }) => a.id === target.id).claimedTasks).toBe(1);
    expect(analysis.inputTokens).toBeNull();
    await harness.commit(async tx => { addTask(await tx.doc(TaskBoard), newTask({ id: "stale", type: "subgoal", role: "author", description: "work" }, 0)); }, context);
    const stale = await call("agent_delegate", { ...draft, taskId: "stale", taskRevision: 0 }, agents.author, "stale-proposal");
    await call("organization_review", { id: stale, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("task_claim", { id: "stale", revision: 0, leaseMs: 1000, operationId: "stale-claim" });
    await expect(call("organization_review", { id: stale, decision: "approve", reason: "review" }, agents.source_reviewer)).rejects.toThrow("Task unavailable or revision conflict");
  } finally { await harness.close(context); }
});

test("scheduler selects the assigned agent and excludes agents that are draining", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context);
    await harness.commit(async tx => {
      const directory = await tx.doc(AgentDirectory);
      const target = directory.agents!.find(a => a.role === "source_reviewer")!;
      const task = newTask({ id: "work", type: "subgoal", role: "author", description: "work" }, 0);
      task.assignedAgentId = target.id;
      addTask(await tx.doc(TaskBoard), task);
    }, context);
    let selected = 0;
    const result = await runScheduler(harness, agents, context, { maxRounds: 1, run: async agent => { selected = agent.id; } });
    expect(result.status).toBe("round_limit");
    expect(selected).toBe(agents.source_reviewer.id);
    await harness.commit(async tx => { (await tx.doc(AgentDirectory)).agents!.find(a => a.role === "source_reviewer")!.status = "draining"; }, context);
    expect((await runScheduler(harness, agents, context, { run: async () => { throw new Error("draining agent was scheduled"); } })).status).toBe("waiting");
  } finally { await harness.close(context); }
});

test("conversation creation and directory registration roll back together", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delm-org-"));
  const path = join(dir, "test.sqlite");
  let harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  try {
    await restoreAgents(harness, context);
    const before = await harness.commit(tx => tx.scanConversations({}, 100), context);
    await expect(harness.commit(async tx => {
      const directory = await tx.doc(AgentDirectory);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      directory.agents!.push({ id: "agent:test", conversationId: String(conversation.id), name: "test", role: "test", capabilities: [], status: "initializing", domainIds: [], goalIds: [], parentAgentId: null, createdAt: 0, updatedAt: 0, lastActiveAt: null, revision: 0 });
      throw new Error("simulated interruption");
    }, context)).rejects.toThrow("simulated interruption");
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
    const after = await harness.commit(tx => tx.scanConversations({}, 100), context);
    expect(after.items.map(c => c.id)).toEqual(before.items.map(c => c.id));
    expect((await harness.snapshot(AgentDirectory, context))!.agents!.some(a => a.id === "agent:test")).toBe(false);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("restore refuses to replace an existing missing conversation", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    await restoreAgents(harness, context);
    await harness.commit(async tx => { (await tx.doc(AgentDirectory)).ids.source_reviewer = 999999; }, context);
    const before = await harness.commit(tx => tx.scanConversations({}, 100), context);
    await expect(restoreAgents(harness, context)).rejects.toThrow("Registered conversation is missing or duplicated");
    expect((await harness.snapshot(AgentDirectory, context))!.ids.source_reviewer).toBe(999999);
    expect((await harness.commit(tx => tx.scanConversations({}, 100), context)).items.map(c => c.id)).toEqual(before.items.map(c => c.id));
  } finally { await harness.close(context); }
});
