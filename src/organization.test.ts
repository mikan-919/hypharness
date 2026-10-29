import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { AgentDirectory, restoreAgents } from "./agents.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import { OrganizationExtension } from "./tools/organization.ts";
import { TaskExtension } from "./tools/tasks.ts";

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
    await harness.commit(async tx => { addTask(await tx.doc(TaskBoard), newTask({ id: "stale", type: "subgoal", role: "author", description: "work" }, 0)); }, context);
    const stale = await call("agent_delegate", { ...draft, taskId: "stale", taskRevision: 0 }, agents.author, "stale-proposal");
    await call("organization_review", { id: stale, decision: "start", reason: "review" }, agents.source_reviewer);
    await call("task_claim", { id: "stale", revision: 0, leaseMs: 1000, operationId: "stale-claim" });
    await expect(call("organization_review", { id: stale, decision: "approve", reason: "review" }, agents.source_reviewer)).rejects.toThrow("Task unavailable or revision conflict");
  } finally { await harness.close(context); }
});
