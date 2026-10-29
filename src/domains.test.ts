import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type Conversation, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreAgents } from "./agents.ts";
import { DomainStore, reconcileDomains } from "./domains.ts";
import { GoalStore, initializeGlobalGoal, applyGoalChange } from "./goals.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { AgentContext } from "./context/state.ts";
import { DomainExtension } from "./tools/domains.ts";
import { GoalExtension } from "./tools/goals.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { runScheduler } from "./scheduler.ts";

const options = { models: createModels(), registry: createRegistry() };
async function fixture(harness: Harness) {
  const agents = await restoreAgents(harness, ctx); let now = 1000000;
  await reconcileDomains(harness, ctx, now); await initializeGlobalGoal(harness, "Find evidence", ctx, now);
  for (const agent of Object.values(agents)) await harness.commit(async tx => { await tx.doc(AgentContext, agent.id); }, ctx);
  const call = async (agent: Conversation, name: string, args: Record<string, unknown>, callId = name) => {
    const tool = [...DomainExtension.tools!, ...GoalExtension.tools!, ...TaskExtension.tools!].find(t => t.name === name)!;
    const api = { conversationId: agent.id, callId, now: () => now, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    const result = await tool.execute(args, api, ctx); if (result.output?.[0]?.type !== "text") throw new Error("No output"); return JSON.parse(result.output[0].text);
  };
  return { agents, call, advance: () => { now += 61000; } };
}
async function seed(harness: Harness) {
  await harness.commit(async tx => { const store = await tx.doc(KnowledgeStore); store.entries.push({ id: "k1", author: "a", raw: "raw1", summary: [{ claim: "x", quote: "raw1" }], gist: "x", status: "verified" }, { id: "k2", author: "a", raw: "raw2", summary: [{ claim: "y", quote: "raw2" }], gist: "y", status: "verified" }); }, ctx);
  await reconcileDomains(harness, ctx, 1000000);
}
const reasons = { reason: "Specific evidence", benefits: "Narrower search", risks: "coordination" };

test("split, merge and transfer keep knowledge references and individual contexts", async () => {
  const harness = await Harness.open(new MemoryStorage(), options, ctx);
  try {
    const { agents, call, advance } = await fixture(harness); const a = agents.author, b = agents.source_reviewer; await seed(harness);
    const originalKnowledge = await harness.snapshot(KnowledgeStore, ctx);
    const state = (await harness.snapshot(DomainStore, ctx))!;
    const parent = state.domains.find(d => d.id === "domain:default")!;
    const children = ["d1", "d2"].map(id => ({ id, name: id, description: "topic", stewardId: String(a.id) }));
    const args = { source: parent.id, domains: children, assignments: [{ knowledgeId: "k1", primaryId: "d1", relatedIds: ["d2"] }, { knowledgeId: "k2", primaryId: "d2", relatedIds: [] }], expectedRevisions: { [parent.id]: parent.revision }, ...reasons };
    await expect(call(b, "domain_split", args, "unauthorized")).rejects.toThrow("steward");
    const p = await call(a, "domain_split", args, "split");
    await expect(call(a, "domain_review", { id: p, decision: "start", reason: "x" })).rejects.toThrow("Independent");
    await call(b, "domain_review", { id: p, decision: "start", reason: "x" }); await call(b, "domain_review", { id: p, decision: "approve", reason: "checked" });
    expect(await call(b, "domain_apply", { id: p })).toBe("applied"); expect(await call(b, "domain_apply", { id: p })).toBe("applied");
    let next = (await harness.snapshot(DomainStore, ctx))!;
    expect(next.memberships.find(m => m.knowledgeId === "k1")).toEqual({ knowledgeId: "k1", primaryId: "d1", relatedIds: ["d2"] });
    expect(next.domains.find(d => d.id === parent.id)?.successorIds).toEqual(["d1", "d2"]);
    expect((await harness.snapshot(KnowledgeStore, ctx))!.entries.map(k => k.raw)).toEqual(["raw1", "raw2"]);
    advance();
    const proposal = await call(a, "domain_merge", { sources: ["d1", "d2"], domain: { id: "merged", name: "merged", description: "same", stewardId: String(a.id) }, expectedRevisions: { d1: 0, d2: 0 }, ...reasons }, "merge");
    await call(b, "domain_review", { id: proposal, decision: "start", reason: "x" }); await call(b, "domain_review", { id: proposal, decision: "approve", reason: "x" }); await call(b, "domain_apply", { id: proposal });
    next = (await harness.snapshot(DomainStore, ctx))!;
    expect(next.memberships.map(m => m.primaryId)).toEqual(["merged", "merged"]); expect(await harness.snapshot(KnowledgeStore, ctx)).toEqual(originalKnowledge);
    advance();
    const contextBefore = await harness.snapshot(AgentContext, a.id, ctx);
    const transfer = await call(a, "domain_transfer", { source: "merged", stewardId: String(b.id), expectedRevisions: { merged: 0 }, ...reasons }, "transfer");
    await call(b, "domain_review", { id: transfer, decision: "start", reason: "x" }); await call(b, "domain_review", { id: transfer, decision: "approve", reason: "x" }); await call(b, "domain_apply", { id: transfer });
    expect((await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "merged")!.stewardId).toBe(String(b.id));
    expect(await harness.snapshot(AgentContext, a.id, ctx)).toEqual(contextBefore);
    const result = await runScheduler(harness, agents, ctx, { now: () => 1122000, run: async agent => {
      const board = (await harness.snapshot(TaskBoard, ctx))!;
      const task = board.tasks.find(t => t.state === "open" && agents[t.role].id === agent.id)!;
      const acquired = await call(agent, "task_claim", { id: task.id, revision: task.revision, leaseMs: 5000, operationId: `claim:${task.id}` });
      await call(agent, "task_finish", { id: task.id, token: acquired.token, revision: acquired.revision, operationId: `finish:${task.id}`, result: "done", failed: false });
    } });
    expect(result.status).toBe("idle");
  } finally { await harness.close(ctx); }
});

test("revision conflicts, relation cycles, goal review and discovery", async () => {
  const harness = await Harness.open(new MemoryStorage(), options, ctx);
  try {
    const { agents, call } = await fixture(harness); const a = agents.author, b = agents.source_reviewer; await seed(harness);
    await expect(initializeGlobalGoal(harness, "Different goal", ctx)).rejects.toThrow("immutable");
    await call(a, "domain_create", { id: "other", name: "other", description: "topic", stewardId: String(a.id), goalIds: [] });
    const original = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "domain:default")!;
    const assignment = { knowledgeId: "k1", primaryId: original.id, relatedIds: ["other"], expectedRevision: original.revision };
    expect(await call(a, "domain_assign", assignment, "assignment")).toEqual(await call(a, "domain_assign", assignment, "assignment"));
    await expect(call(a, "domain_assign", assignment, "stale-assignment")).rejects.toThrow("revision conflict");
    const primary = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "domain:default")!;
    const p = await call(a, "domain_transfer", { source: primary.id, stewardId: String(b.id), expectedRevisions: { [primary.id]: primary.revision }, ...reasons }, "stale");
    await call(b, "domain_review", { id: p, decision: "start", reason: "x" }); await call(b, "domain_review", { id: p, decision: "approve", reason: "x" });
    await call(a, "domain_link", { from: primary.id, to: "other", type: "depends_on", evidence: "shared task", expectedRevision: primary.revision }, "link1");
    await expect(call(b, "domain_apply", { id: p })).rejects.toThrow("revision conflict");
    const other = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "other")!;
    await expect(call(a, "domain_link", { from: "other", to: primary.id, type: "depends_on", evidence: "reverse", expectedRevision: other.revision }, "link2")).rejects.toThrow("Circular");
    const result = await call(a, "domain_discover", { domainIds: [primary.id, "other"], evidence: "shared task", hypothesis: "Test interaction" }, "discovery");
    expect((await harness.snapshot(TaskBoard, ctx))!.tasks.some(t => t.id === result.taskId && t.type === "hypothesis")).toBe(true);
    expect(result.matches).toContain("k1");
    expect((await harness.snapshot(KnowledgeStore, ctx))!.entries.length).toBe(2);
    const hypothesis = await call(a, "task_claim", { id: result.taskId, revision: 0, leaseMs: 5000, operationId: "claim-hypothesis" });
    await call(a, "task_finish", { id: result.taskId, token: hypothesis.token, revision: hypothesis.revision, operationId: "finish-hypothesis", result: "tested", failed: false });
    await expect(call(b, "domain_discovery_feedback", { id: result.id, productive: true, reason: "tested" })).rejects.toThrow("task owner");
    expect(await call(a, "domain_discovery_feedback", { id: result.id, productive: true, reason: "tested" })).toBe("productive");
    const goal = { id: "g1", description: "Investigate", parentId: "goal:global", domainIds: ["other"], dependencies: [] };
    await expect(call(a, "goal_propose", { kind: "create", sources: [], goals: [{ ...goal, id: "cycle", dependencies: ["cycle"] }], expectedRevisions: {}, reason: "x", alignment: "x" }, "cycle")).rejects.toThrow("Circular");
    const gp = await call(a, "goal_propose", { kind: "create", sources: [], goals: [goal], expectedRevisions: {}, reason: "Evidence", alignment: "Supports global goal" }, "goal1");
    await expect(call(a, "goal_review", { id: gp, decision: "start", reason: "x" })).rejects.toThrow("Independent");
    await call(b, "goal_review", { id: gp, decision: "start", reason: "x" }); await call(b, "goal_review", { id: gp, decision: "approve", reason: "x" }); await call(b, "goal_apply", { id: gp });
    expect((await harness.snapshot(GoalStore, ctx))!.goals.find(g => g.id === "g1")?.description).toBe("Investigate");
    const modified = { ...goal, description: "Investigate further" };
    const update = { kind: "update", sources: ["g1"], goals: [modified], expectedRevisions: { g1: 0 }, reason: "New evidence", alignment: "Supports global goal" };
    await expect(call(a, "goal_propose", update, "blocked-update")).rejects.toThrow("active tasks");
    const work = (await harness.snapshot(TaskBoard, ctx))!.tasks.find(t => t.goalId === "g1")!;
    const claimed = await call(a, "task_claim", { id: work.id, revision: work.revision, leaseMs: 5000, operationId: "claim-work" });
    await call(a, "task_finish", { id: work.id, token: claimed.token, revision: claimed.revision, operationId: "finish-work", result: "done", failed: false });
    const updateId = await call(a, "goal_propose", update, "update");
    await call(b, "goal_review", { id: updateId, decision: "start", reason: "x" }); await call(b, "goal_review", { id: updateId, decision: "approve", reason: "x" }); await call(b, "goal_apply", { id: updateId });
    expect((await harness.snapshot(GoalStore, ctx))!.goals.find(g => g.id === "g1")?.description).toBe("Investigate further");
    await expect(call(a, "goal_propose", { kind: "cancel", sources: ["goal:global"], goals: [], expectedRevisions: { "goal:global": 0 }, reason: "x", alignment: "x" }, "global")).rejects.toThrow("immutable");
  } finally { await harness.close(ctx); }
});

test("domain and goal state survive SQLite restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "domains-")); const file = join(dir, "db.sqlite");
  try {
    let harness = await Harness.open(await openNodeSqliteStorage(file), options, ctx);
    const { agents, call } = await fixture(harness); await call(agents.author, "domain_create", { id: "persistent", name: "p", description: "p", stewardId: String(agents.author.id), goalIds: [] });
    const pending = await call(agents.author, "domain_transfer", { source: "persistent", stewardId: String(agents.source_reviewer.id), expectedRevisions: { persistent: 0 }, ...reasons }, "restart-proposal");
    await harness.close(ctx);
    harness = await Harness.open(await openNodeSqliteStorage(file), options, ctx);
    try {
      const restored = await fixture(harness);
      expect((await harness.snapshot(DomainStore, ctx))!.proposals.find(p => p.id === pending)?.status).toBe("proposed");
      await restored.call(restored.agents.source_reviewer, "domain_review", { id: pending, decision: "start", reason: "x" });
      await restored.call(restored.agents.source_reviewer, "domain_review", { id: pending, decision: "approve", reason: "x" });
      await restored.call(restored.agents.source_reviewer, "domain_apply", { id: pending });
      expect((await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "persistent")?.stewardId).toBe(String(restored.agents.source_reviewer.id));
      expect((await harness.snapshot(GoalStore, ctx))!.goals[0]!.description).toBe("Find evidence");
    } finally { await harness.close(ctx); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("active knowledge claims prevent reorganization without changing claim ownership", async () => {
  const harness = await Harness.open(new MemoryStorage(), options, ctx);
  try {
    const { agents, call } = await fixture(harness); await seed(harness);
    await harness.commit(async tx => {
      const board = await tx.doc(TaskBoard); const task = newTask({ id: "in-progress", type: "research", description: "research", role: "author", knowledgeId: "k1" }, 1);
      task.state = "claimed"; task.owner = String(agents.author.id); task.token = "claim-token"; task.leaseUntil = 2000000;
      addTask(board, task);
    }, ctx);
    const domain = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "domain:default")!;
    await expect(call(agents.author, "domain_split", { source: domain.id, domains: ["x", "y"].map(id => ({ id, name: id, description: id, stewardId: String(agents.author.id) })), assignments: [{ knowledgeId: "k1", primaryId: "x", relatedIds: [] }, { knowledgeId: "k2", primaryId: "y", relatedIds: [] }], expectedRevisions: { [domain.id]: domain.revision }, ...reasons })).rejects.toThrow("claimed tasks");
    const task = (await harness.snapshot(TaskBoard, ctx))!.tasks.find(t => t.id === "in-progress")!;
    expect(task.token).toBe("claim-token"); expect(task.owner).toBe(String(agents.author.id));
  } finally { await harness.close(ctx); }
});

test("analysis is queued only when evidence thresholds are met and is not duplicated", async () => {
  const harness = await Harness.open(new MemoryStorage(), options, ctx);
  try {
    const { agents, call } = await fixture(harness); await seed(harness);
    await harness.commit(async tx => { const store = await tx.doc(KnowledgeStore); for (const id of ["k3", "k4"]) store.entries.push({ id, author: "a", raw: "raw", summary: [{ claim: "c", quote: "raw" }], gist: "g", status: "verified" }); }, ctx);
    await reconcileDomains(harness, ctx, 1000000);
    expect((await harness.snapshot(TaskBoard, ctx))!.tasks.filter(t => t.type === "domain_analysis").length).toBe(0);
    await call(agents.author, "domain_create", { id: "linked", name: "linked", description: "linked", stewardId: String(agents.author.id), goalIds: [] });
    let domain = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "domain:default")!;
    await call(agents.author, "domain_assign", { knowledgeId: "k1", primaryId: domain.id, relatedIds: ["linked"], expectedRevision: domain.revision }, "analysis-assignment");
    domain = (await harness.snapshot(DomainStore, ctx))!.domains.find(d => d.id === "domain:default")!;
    await call(agents.author, "domain_link", { from: domain.id, to: "linked", type: "related", evidence: "shared evidence", expectedRevision: domain.revision }, "analysis-link");
    await reconcileDomains(harness, ctx, 1000000); await reconcileDomains(harness, ctx, 1000000);
    expect((await harness.snapshot(TaskBoard, ctx))!.tasks.filter(t => t.type === "domain_analysis").length).toBe(1);
    expect((await call(agents.author, "domain_analyze", { id: domain.id })).suggestion).toBe("keep");
  } finally { await harness.close(ctx); }
});

test("goal split and merge preserve hierarchy and dependencies", async () => {
  const harness = await Harness.open(new MemoryStorage(), options, ctx);
  try {
    await fixture(harness);
    const state = JSON.parse(JSON.stringify(await harness.snapshot(GoalStore, ctx)));
    const base = { id: "one", description: "one", parentId: "goal:global", domainIds: [], dependencies: [] };
    applyGoalChange(state, { kind: "create", sources: [], goals: [base] }, [], [], 1);
    const children = ["left", "right"].map(id => ({ ...base, id, description: id }));
    applyGoalChange(state, { kind: "split", sources: ["one"], goals: children }, [], [], 2);
    expect(state.goals.find((g: { id: string }) => g.id === "one").status).toBe("superseded");
    applyGoalChange(state, { kind: "merge", sources: ["left", "right"], goals: [{ ...base, id: "combined" }] }, [], [], 3);
    expect(state.goals.find((g: { id: string }) => g.id === "combined").parentId).toBe("goal:global");
    expect(state.goals.find((g: { id: string }) => g.id === "left").status).toBe("superseded");
  } finally { await harness.close(ctx); }
});
