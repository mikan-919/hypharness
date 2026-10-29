import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { configure, createRegistry, Harness, MemoryStorage, type HookApi, type ToolHookCall, type ToolHooks, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDirectory, AgentPermissionExtension, canClaimTask, canUseTool, restoreAgents, type AgentRecord } from "./agents.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { OrganizationExtension } from "./tools/organization.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { runScheduler } from "./scheduler.ts";
import { AgentContext } from "./context/state.ts";
import { ORGANIZATION_LIMITS, OrganizationStore } from "./organization.ts";
import { initializeGlobalGoal } from "./goals.ts";
import { DomainStore, reconcileDomains } from "./domains.ts";
import { parseExperimentArgs } from "./experiment.ts";

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

test("comparison requires one goal and the same explicit task list", () => {
  expect(parseExperimentArgs(["--goal", "g", "--task", "a", "--task", "b"])).toEqual({ goal: "g", tasks: ["a", "b"] });
  expect(() => parseExperimentArgs(["--goal", "--task", "a"])).toThrow("Usage");
  expect(() => parseExperimentArgs(["--goal", "g", "--goal", "g", "--task", "a"])).toThrow("Only one goal");
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

test("new conversation, agent configuration, and context commit together", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    await restoreAgents(harness, context);
    const id = await harness.commit(async tx => {
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      await configure(tx, conversation.id, { instructions: "fixed goal" });
      (await tx.doc(AgentContext, conversation.id)).workingMemory = "initial context";
      return conversation.id;
    }, context);
    expect((await (await harness.conversation(id, context))!.agent(context)).instructions).toBe("fixed goal");
    expect((await harness.snapshot(AgentContext, id, context))!.workingMemory).toBe("initial context");
  } finally { await harness.close(context); }
});

test("approved spawn is atomic, idempotent and discoverable by scheduler", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delm-spawn-")); const path = join(dir, "test.sqlite");
  let harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context);
    await initializeGlobalGoal(harness, "fixed goal", context);
    let now = 1000;
    await harness.commit(async tx => {
      addTask(await tx.doc(TaskBoard), newTask({ id: "specialized", type: "subgoal", role: "author", description: "specialized work", goalId: "goal:global", requiredSpecialty: "specialist" }, 0));
      (await tx.doc(OrganizationStore)).run = { id: "test-run", round: 0, spawns: 0, roundSpawns: 0, roundChanges: 0, limits: { ...ORGANIZATION_LIMITS } };
    }, context);
    const call = async (name: string, args: Record<string, unknown>, agent = agents.author, callId = name) => {
      const tool = OrganizationExtension.tools!.find(t => t.name === name)!;
      const api = { conversationId: agent.id, callId, now: () => now, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
      const result = await tool.execute(args, api, context); const item = result.output?.[0]; return item?.type === "text" ? JSON.parse(item.text) : null;
    };
    const args = { name: "specialist", role: "specialist", capabilities: ["research", "task_management"], initialGoalIds: ["goal:global"], initialDomainIds: [], taskId: "specialized", taskRevision: 0, goalRevisions: { "goal:global": 0 }, domainRevisions: {}, reason: "specialist needed", reuseReason: "no specialist", benefits: "specialization", costs: "model calls", risks: "coordination" };
    const proposal = await call("organization_propose", args);
    await expect(call("agent_spawn", { id: proposal })).rejects.toThrow("Independent approval required");
    await call("organization_review", { id: proposal, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("organization_review", { id: proposal, decision: "approve", reason: "review" }, agents.source_reviewer);
    expect(await call("agent_spawn", { id: proposal })).toBe("applied");
    expect(await call("agent_spawn", { id: proposal })).toBe("applied");
    const directory = await harness.snapshot(AgentDirectory, context); const agent = directory!.agents!.find(a => a.id === `agent:${proposal}`)!;
    expect(agent.status).toBe("active");
    expect((await harness.snapshot(OrganizationStore, context))!.run!.spawns).toBe(1);
    expect((await harness.snapshot(AgentContext, Number(agent.conversationId) as typeof agents.author.id, context))!.version).toBe(0);
    await harness.commit(async tx => {
      const board = await tx.doc(TaskBoard);
      addTask(board, newTask({ id: "reuse", type: "subgoal", role: "author", description: "work", requiredSpecialty: "specialist" }, 0));
      addTask(board, newTask({ id: "other", type: "subgoal", role: "author", description: "work", requiredSpecialty: "other" }, 0));
    }, context);
    await expect(call("organization_propose", { ...args, taskId: "reuse", initialGoalIds: [], goalRevisions: {} }, agents.author, "reuse")).rejects.toThrow("Existing agent can be reused");
    await expect(call("organization_propose", { ...args, taskId: "other", role: "other", initialGoalIds: [], goalRevisions: {} }, agents.author, "limit")).rejects.toThrow("Organization budget exhausted");
    now += 60001;
    const lifecycle = { agentId: agent.id, agentRevision: agent.revision, reason: "work complete", benefits: "fewer calls", risks: "restart" };
    await expect(call("agent_retire", lifecycle)).rejects.toThrow("Agent has unfinished tasks");
    await harness.commit(async tx => { const task = (await tx.doc(TaskBoard)).tasks.find(t => t.id === "specialized")!; task.state = "completed"; (await tx.doc(AgentContext, Number(agent.conversationId) as typeof agents.author.id)).workingMemory = "retained"; }, context);
    const retirement = await call("agent_retire", lifecycle);
    await call("organization_review", { id: retirement, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("organization_review", { id: retirement, decision: "approve", reason: "review" }, agents.source_reviewer);
    await call("organization_apply", { id: retirement });
    expect((await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.id === agent.id)!.status).toBe("dormant");
    expect((await harness.snapshot(AgentContext, Number(agent.conversationId) as typeof agents.author.id, context))!.workingMemory).toBe("retained");
    now += 60001;
    await harness.commit(async tx => { const run = (await tx.doc(OrganizationStore)).run!; run.round++; run.roundChanges = 0; run.roundSpawns = 0; }, context);
    const resumption = await call("agent_reuse", { ...lifecycle, agentRevision: 2 }, agents.author, "reuse-agent");
    await call("organization_review", { id: resumption, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("organization_review", { id: resumption, decision: "approve", reason: "review" }, agents.source_reviewer);
    await call("organization_apply", { id: resumption });
    expect((await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.id === agent.id)!.conversationId).toBe(agent.conversationId);
    expect((await harness.snapshot(AgentContext, Number(agent.conversationId) as typeof agents.author.id, context))!.workingMemory).toBe("retained");
    await harness.commit(async tx => { (await tx.doc(TaskBoard)).tasks.find(t => t.id === "specialized")!.state = "open"; }, context);
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
    const restored = await restoreAgents(harness, context);
    expect((await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.id === agent.id)!.conversationId).toBe(agent.conversationId);
    let selected = 0;
    await runScheduler(harness, restored, context, { maxRounds: 1, run: async a => { selected = a.id; } });
    expect(String(selected)).toBe(agent.conversationId);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("handoff moves open tasks and domain stewardship without moving context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delm-handoff-")); const path = join(dir, "test.sqlite");
  let harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context); await reconcileDomains(harness, context);
    await harness.commit(async tx => {
      addTask(await tx.doc(TaskBoard), newTask({ id: "handoff-work", type: "subgoal", role: "author", description: "work" }, 0));
      (await tx.doc(OrganizationStore)).run = { id: "test", round: 0, spawns: 0, roundSpawns: 0, roundChanges: 0, limits: { ...ORGANIZATION_LIMITS } };
      (await tx.doc(AgentContext, agents.author.id)).workingMemory = "private";
    }, context);
    const directory = (await harness.snapshot(AgentDirectory, context))!; const from = directory.agents!.find(a => a.role === "author")!; const to = directory.agents!.find(a => a.role === "source_reviewer")!;
    const call = async (name: string, args: Record<string, unknown>, agent = agents.author) => { const tool = [...OrganizationExtension.tools!, ...TaskExtension.tools!].find(t => t.name === name)!; const api = { conversationId: agent.id, callId: name, now: () => 1000, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi; const result = await tool.execute(args, api, context); const item = result.output?.[0]; return item?.type === "text" ? JSON.parse(item.text) : null; };
    const args = { toAgentId: to.id, fromRevision: from.revision, toRevision: to.revision, taskIds: ["handoff-work"], domainIds: ["domain:default"], goalIds: [], knowledgeIds: [], taskRevisions: { "handoff-work": 0 }, domainRevisions: { "domain:default": 0 }, goalRevisions: {}, summary: "work in progress", reason: "handoff", benefits: "continuity", risks: "coordination" };
    const claimed = await call("task_claim", { id: "handoff-work", revision: 0, leaseMs: 1000, operationId: "claim" });
    await expect(call("agent_handoff", args)).rejects.toThrow("Handoff task unavailable");
    await call("task_release", { id: "handoff-work", token: claimed.token, revision: claimed.revision, operationId: "release" });
    const proposal = await call("agent_handoff", { ...args, taskRevisions: { "handoff-work": 2 } });
    await harness.close(context); harness = await Harness.open(await openNodeSqliteStorage(path), { models: createModels(), registry: createRegistry() }, context); await restoreAgents(harness, context);
    await call("organization_review", { id: proposal, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("organization_review", { id: proposal, decision: "approve", reason: "review" }, agents.source_reviewer);
    await call("organization_apply", { id: proposal }); await call("organization_apply", { id: proposal });
    expect((await harness.snapshot(TaskBoard, context))!.tasks.find(t => t.id === "handoff-work")!.assignedAgentId).toBe(to.id);
    expect((await harness.snapshot(DomainStore, context))!.domains.find(d => d.id === "domain:default")!.stewardId).toBe(to.conversationId);
    expect((await harness.snapshot(AgentContext, agents.author.id, context))!.workingMemory).toBe("private");
    expect(await harness.snapshot(AgentContext, agents.source_reviewer.id, context)).toBeUndefined();
    expect((await harness.snapshot(OrganizationStore, context))!.handoffs!.find(p => p.id === proposal)!.handoffStatus).toBe("committed");
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("consolidation transfers open work and retains the source conversation and context", async () => {
  const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
  try {
    const agents = await restoreAgents(harness, context);
    const dynamicId = await harness.commit(async tx => {
      const directory = await tx.doc(AgentDirectory); const board = await tx.doc(TaskBoard); const organization = await tx.doc(OrganizationStore);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      (await tx.doc(AgentContext, conversation.id)).workingMemory = "preserved source";
      directory.agents!.push({ id: "agent:dynamic", conversationId: String(conversation.id), name: "worker", role: "research", capabilities: ["research", "task_management"], status: "active", domainIds: [], goalIds: [], parentAgentId: null, createdAt: 0, updatedAt: 0, lastActiveAt: null, revision: 0 });
      const task = newTask({ id: "dynamic-task", type: "subgoal", role: "author", description: "work" }, 0); task.assignedAgentId = "agent:dynamic"; addTask(board, task);
      organization.run = { id: "test", round: 0, spawns: 0, roundSpawns: 0, roundChanges: 0, limits: { ...ORGANIZATION_LIMITS } }; return conversation.id;
    }, context);
    const call = async (name: string, args: Record<string, unknown>, conversationId: typeof dynamicId) => { const tool = OrganizationExtension.tools!.find(t => t.name === name)!; const api = { conversationId, callId: name, now: () => 100000, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi; const result = await tool.execute(args, api, context); const item = result.output?.[0]; return item?.type === "text" ? JSON.parse(item.text) : null; };
    const target = (await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.role === "source_reviewer")!;
    const proposal = await call("agent_consolidate", { toAgentId: target.id, fromRevision: 0, toRevision: target.revision, taskIds: ["dynamic-task"], domainIds: [], goalIds: [], knowledgeIds: [], taskRevisions: { "dynamic-task": 0 }, domainRevisions: {}, goalRevisions: {}, summary: "handoff", reason: "overlap", benefits: "fewer agents", risks: "coordination" }, dynamicId);
    await call("organization_review", { id: proposal, decision: "start", reason: "review" }, agents.author.id);
    await call("organization_review", { id: proposal, decision: "approve", reason: "review" }, agents.author.id);
    await call("organization_apply", { id: proposal }, agents.author.id);
    expect((await harness.snapshot(AgentDirectory, context))!.agents!.find(a => a.id === "agent:dynamic")!.status).toBe("dormant");
    expect((await harness.snapshot(TaskBoard, context))!.tasks.find(t => t.id === "dynamic-task")!.assignedAgentId).toBe(target.id);
    expect((await harness.snapshot(AgentContext, dynamicId, context))!.workingMemory).toBe("preserved source");
    expect(await harness.conversation(dynamicId, context)).toBeDefined();
  } finally { await harness.close(context); }
});
