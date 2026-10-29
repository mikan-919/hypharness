import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreAgents } from "./agents.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { TaskExtension } from "./tools/tasks.ts";
import { KnowledgeExtension } from "./tools/knowledge.ts";
import { reconcileKnowledge } from "./workflow.ts";
import { runScheduler } from "./scheduler.ts";

const options = { models: createModels(), registry: createRegistry() };
async function setup() { const harness = await Harness.open(new MemoryStorage(), options, context); return { harness, agents: await restoreAgents(harness, context) }; }

test("directory reuses conversations and scheduler stops with no tasks", async () => {
  const { harness, agents } = await setup();
  try {
    const restored = await restoreAgents(harness, context);
    expect(Object.values(restored).map(a => a.id)).toEqual(Object.values(agents).map(a => a.id));
    expect(await runScheduler(harness, agents, context)).toEqual({ status: "idle", rounds: 0 });
  } finally { await harness.close(context); }
});

test("claim competition, ownership, lease expiry, idempotence, split and dependencies", async () => {
  const { harness, agents } = await setup(); let now = 1000;
  const call = async (name: string, args: Record<string, unknown>, agent = agents.author) => {
    const tool = TaskExtension.tools!.find(t => t.name === name)!;
    const api = { conversationId: agent.id, now: () => now, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    const result = await tool.execute(args, api, context);
    return result.output?.[0]?.type === "text" ? result.output[0].text : "";
  };
  try {
    await call("task_create", { id: "a", type: "work", description: "work", role: "author", dependencies: [], operationId: "create" });
    await call("task_create", { id: "a", type: "work", description: "work", role: "author", dependencies: [], operationId: "create" });
    const args = { id: "a", revision: 0, leaseMs: 1000, operationId: "claim" };
    const [first, second] = await Promise.allSettled([call("task_claim", args), call("task_claim", { ...args, operationId: "other" })]);
    expect(first.status).toBe("fulfilled"); expect(second.status).toBe("rejected");
    const task = JSON.parse((first as PromiseFulfilledResult<string>).value);
    expect(await call("task_claim", args)).toBe((first as PromiseFulfilledResult<string>).value);
    await expect(call("task_finish", { id: "a", token: task.token, revision: task.revision, operationId: "wrong", result: "x", failed: false }, agents.source_reviewer)).rejects.toThrow();
    now = 2000;
    const next = JSON.parse(await call("task_claim", { ...args, revision: 1, operationId: "reclaim" }));
    await expect(call("task_finish", { id: "a", token: task.token, revision: task.revision, operationId: "stale", result: "x", failed: false })).rejects.toThrow();
    await call("task_split", { id: "a", token: next.token, revision: next.revision, operationId: "split", children: [{ id: "b", type: "work", description: "b", role: "author", dependencies: [] }, { id: "c", type: "work", description: "c", role: "author", dependencies: ["b"] }] });
    await expect(call("task_claim", { id: "c", revision: 0, leaseMs: 1000, operationId: "blocked" })).rejects.toThrow();
    const b = JSON.parse(await call("task_claim", { id: "b", revision: 0, leaseMs: 1000, operationId: "claim-b" }));
    await call("task_finish", { id: "b", token: b.token, revision: b.revision, operationId: "finish-b", result: "ok", failed: false });
    expect(JSON.parse(await call("task_claim", { id: "c", revision: 0, leaseMs: 1000, operationId: "claim-c" })).state).toBe("claimed");
    await expect(call("task_create", { id: "cycle", type: "work", description: "x", role: "author", dependencies: ["cycle"], operationId: "cycle" })).rejects.toThrow();
    await call("task_create", { id: "parent", type: "work", description: "x", role: "author", dependencies: [], operationId: "parent" });
    await call("task_create", { id: "dependent", type: "work", description: "x", role: "author", dependencies: ["parent"], operationId: "dependent" });
    const parent = JSON.parse(await call("task_claim", { id: "parent", revision: 0, leaseMs: 1000, operationId: "claim-parent" }));
    await expect(call("task_split", { id: "parent", token: parent.token, revision: parent.revision, operationId: "cycle-split", children: [{ id: "child", type: "work", description: "x", role: "author", dependencies: ["dependent"] }] })).rejects.toThrow("Circular dependency");
    expect((await harness.snapshot(TaskBoard, context))!.tasks.some(t => t.id === "child")).toBe(false);
  } finally { await harness.close(context); }
});

test("knowledge tasks are generated once for each stage", async () => {
  const { harness } = await setup();
  try {
    await harness.commit(async tx => { (await tx.doc(KnowledgeStore)).entries.push({ id: "k", author: "a", raw: "r", summary: [{ claim: "r", quote: "r" }], gist: "r", status: "proposed" }); }, context);
    await reconcileKnowledge(harness, context); await reconcileKnowledge(harness, context);
    expect((await harness.snapshot(TaskBoard, context))?.tasks.map(t => t.type)).toEqual(["review_source"]);
    await harness.commit(async tx => { (await tx.doc(KnowledgeStore)).entries[0]!.status = "source_checked"; }, context);
    await reconcileKnowledge(harness, context);
    expect((await harness.snapshot(TaskBoard, context))?.tasks.map(t => t.type)).toEqual(["review_source", "review_gist"]);
  } finally { await harness.close(context); }
});

test("scheduler completes a proposal and both reviews through claimed tasks", async () => {
  const { harness, agents } = await setup();
  let calls = 0;
  const call = async (name: string, args: Record<string, unknown>, agent: typeof agents.author, callId: string) => {
    const tool = [...TaskExtension.tools!, ...KnowledgeExtension.tools!].find(t => t.name === name)!;
    const api = { conversationId: agent.id, callId, now: () => 1000, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    const result = await tool.execute(args, api, context);
    return result.output?.[0]?.type === "text" ? result.output[0].text : "";
  };
  try {
    await harness.commit(async tx => { addTask(await tx.doc(TaskBoard), newTask({ id: "proposal", type: "propose", description: "raw", role: "author" }, 1)); }, context);
    const result = await runScheduler(harness, agents, context, { now: () => 1000, run: async (agent) => {
      const board = await harness.snapshot(TaskBoard, context);
      const task = board!.tasks.find(t => t.state === "open" && agents[t.role].id === agent.id)!;
      const acquired = JSON.parse(await call("task_claim", { id: task.id, revision: task.revision, leaseMs: 5000, operationId: `claim-${calls}` }, agent, `claim-${calls}`));
      if (task.type === "propose") {
        await call("knowledge_propose", { raw: "raw", summary: [{ claim: "raw", quote: "raw" }], gist: "raw", taskId: task.id, token: acquired.token, revision: acquired.revision }, agent, "proposal-call");
      } else {
        const stage = task.type === "review_source" ? "source" : "gist";
        const args = { id: task.knowledgeId, stage, approved: true, reason: "ok", token: acquired.token, revision: acquired.revision };
        expect(await call("knowledge_review", args, agent, `review-${stage}`)).toBe(stage === "source" ? "source_checked" : "verified");
        expect(await call("knowledge_review", args, agent, `review-${stage}`)).toBe(stage === "source" ? "source_checked" : "verified");
      }
      calls++;
    } });
    expect(result).toEqual({ status: "idle", rounds: 3 });
    const knowledge = (await harness.snapshot(KnowledgeStore, context))!.entries[0]!;
    expect(knowledge.status).toBe("verified");
    expect(new Set([knowledge.author, knowledge.sourceReviewer, knowledge.gistReviewer]).size).toBe(3);
    expect((await harness.snapshot(TaskBoard, context))!.tasks.every(t => t.state === "completed")).toBe(true);
  } finally { await harness.close(context); }
});

test("SQLite restores directory and task board after reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delm-test-")); const path = join(dir, "session.sqlite");
  try {
    let harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    const agents = await restoreAgents(harness, context);
    await harness.commit(async tx => { addTask(await tx.doc(TaskBoard), newTask({ id: "persist", type: "work", description: "work", role: "author" }, 1)); }, context);
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    try {
      const restored = await restoreAgents(harness, context);
      expect(restored.source_reviewer.id).toBe(agents.source_reviewer.id);
      expect((await harness.snapshot(TaskBoard, context))?.tasks[0]?.id).toBe("persist");
    } finally { await harness.close(context); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
