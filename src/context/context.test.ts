import { test, expect } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import type { Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness, MemoryStorage, type Conversation, type GenerationHooks, type HookApi, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { restoreAgents } from "../agents.ts";
import { SharedMemory } from "../memory.ts";
import { AgentContext } from "./state.ts";
import { createContextExtension } from "./extension.ts";
import { render } from "./renderer.ts";
import { syncMirror } from "./mirror.ts";

const options = { models: createModels(), registry: createRegistry() };
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const assistant = (content: string): Message => ({ role: "assistant", content: [{ type: "text", text: content }], api: "openai-responses", provider: "openai", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 1 });

async function fixture(harness: Harness, root: string) {
  const agents = await restoreAgents(harness, context);
  for (const agent of Object.values(agents)) await harness.commit(async tx => { await tx.doc(AgentContext, agent.id); }, context);
  const extension = createContextExtension(harness, root);
  const call = async (agent: Conversation, name: string, args: Record<string, unknown>, callId = name) => {
    const tool = extension.tools!.find(tool => tool.name === name)!;
    const api = { conversationId: agent.id, callId, now: () => 123, commit: harness.commit.bind(harness), snapshot: harness.snapshot.bind(harness) } as unknown as ToolExecutionApi;
    const result = await tool.execute(args, api, context);
    if (result.output?.[0]?.type !== "text") throw new Error("No output");
    return JSON.parse(result.output[0].text);
  };
  return { agents, extension, call };
}

test("owner edits, bounded cross-agent read, version conflict, idempotence, restore and mirror", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clm-"));
  const harness = await Harness.open(new MemoryStorage(), options, context);
  try {
    const { agents, call } = await fixture(harness, dir);
    const author = agents.author, reviewer = agents.source_reviewer;
    const edit = { operation: "replace", content: "hello", expectedVersion: 0, operationId: "one" };
    expect(await call(author, "context_edit", edit)).toEqual({ version: 1 });
    expect(await call(author, "context_edit", edit)).toEqual({ version: 1 });
    expect((await call(reviewer, "context_read", { agentId: author.id, maxChars: 2 })).content).toBe("he");
    await expect(call(author, "context_edit", { ...edit, operationId: "two" })).rejects.toThrow("version conflict");
    await call(reviewer, "context_edit", { ...edit, content: "reviewer", operationId: "own", agentId: author.id });
    expect((await harness.snapshot(AgentContext, author.id, context))!.workingMemory).toBe("hello");
    expect((await harness.snapshot(AgentContext, reviewer.id, context))!.workingMemory).toBe("reviewer");
    await expect(call(author, "context_edit", { operation: "append", content: "x".repeat(30000), expectedVersion: 1, operationId: "large" })).rejects.toThrow("budget");
    expect(await call(author, "context_restore", { targetVersion: 0, expectedVersion: 1 }, "restore-0")).toEqual({ version: 2 });
    expect(await call(author, "context_restore", { targetVersion: 1, expectedVersion: 2 }, "restore-1")).toEqual({ version: 3 });
    expect((await call(author, "context_history", {})).map((h: { version: number }) => h.version)).toEqual([0, 1, 2, 3]);
    const file = join(dir, String(author.id), "LIVE_CTX.md");
    expect(await readFile(file, "utf8")).toContain("hello");
    await writeFile(file, "corrupt"); await syncMirror(harness, author.id, context, dir);
    expect(await readFile(file, "utf8")).toContain("hello");
    await harness.commit(async tx => { (await tx.doc(SharedMemory)).memories.push({ id: "m", author: "a", content: "x", createdAt: 1 }); }, context);
    expect((await harness.snapshot(AgentContext, reviewer.id, context))!.version).toBe(1);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("checkpoint removes only verified completed prefix and hook preserves fixed prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clm-")); const harness = await Harness.open(new MemoryStorage(), options, context);
  try {
    const { agents, call, extension } = await fixture(harness, dir);
    const agent = agents.author;
    const unfinished = await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [user("old")] }), context);
    const old = await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [assistant("answer")] }), context);
    await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [user("new")] }), context);
    await expect(call(agent, "context_checkpoint", { coveredThroughEntryId: unfinished.id, summary: "summary", expectedVersion: 0 }, "unfinished")).rejects.toThrow("completed assistant");
    expect(await call(agent, "context_checkpoint", { coveredThroughEntryId: old.id, summary: "summary", expectedVersion: 0 })).toEqual({ version: 1 });
    await call(agent, "context_edit", { operation: "replace", content: "memo", expectedVersion: 1, operationId: "memory" });
    const view = await agent.context(context);
    const fixed: Message = { role: "system", content: "fixed", timestamp: 0 };
    const handlers = extension.hooks![0]!.handlers as Partial<GenerationHooks>;
    const api = { conversationId: agent.id, snapshot: harness.snapshot.bind(harness), models: options.models } as unknown as HookApi;
    const result = await handlers.beforeRequest!({ messages: view.messages }, api, context);
    expect(result!.messages.some(m => m.role === "user" && m.content === "old")).toBe(false);
    expect(result!.messages.some(m => m.role === "user" && m.content === "new")).toBe(true);
    expect(JSON.stringify(result!.messages)).toContain("memo");
    const state = (await harness.snapshot(AgentContext, agent.id, context))!;
    const input = [fixed, user("changed"), user("latest")];
    const a = render(input, state), b = render(input, state);
    expect(a).toEqual(b); expect(a[0]).toEqual(fixed);
    expect(a.some(m => m.role === "user" && m.content === "changed")).toBe(true);
    expect(() => render([fixed, user("x".repeat(40000))], state)).toThrow("budget exceeded");
    expect((await agent.context(context)).entries.length).toBe(3);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});

test("SQLite reopens context with the same version and checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clm-sqlite-")); const path = join(dir, "session.sqlite");
  try {
    let harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    const first = await fixture(harness, dir);
    await first.call(first.agents.author, "context_edit", { operation: "replace", content: "persistent", expectedVersion: 0, operationId: "p" });
    await first.agents.author.commit(tx => tx.appendEntry(first.agents.author.id, { kind: "test", model: [user("old")] }), context);
    const completed = await first.agents.author.commit(tx => tx.appendEntry(first.agents.author.id, { kind: "test", model: [assistant("done")] }), context);
    await first.agents.author.commit(tx => tx.appendEntry(first.agents.author.id, { kind: "test", model: [user("new")] }), context);
    await first.call(first.agents.author, "context_checkpoint", { coveredThroughEntryId: completed.id, summary: "remember", expectedVersion: 1 });
    await harness.close(context);
    harness = await Harness.open(await openNodeSqliteStorage(path), options, context);
    try { const second = await fixture(harness, dir); const state = await harness.snapshot(AgentContext, second.agents.author.id, context); expect(state?.version).toBe(2); expect(state?.workingMemory).toBe("persistent"); expect(state?.checkpoint.coveredThroughEntryId).toBe(completed.id); expect(state?.checkpoint.summary).toBe("remember"); }
    finally { await harness.close(context); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an incomplete tool call cannot be checkpointed and remains in model input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "clm-tools-")); const harness = await Harness.open(new MemoryStorage(), options, context);
  try {
    const { agents, call } = await fixture(harness, dir); const agent = agents.author;
    const base = assistant("x");
    if (base.role !== "assistant") throw new Error("Invalid fixture");
    await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [user("old")] }), context);
    const pending = await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [{ ...base, content: [{ type: "toolCall", id: "call-1", name: "test", arguments: {} }], stopReason: "toolUse" }] }), context);
    await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [{ role: "toolResult", toolCallId: "call-1", toolName: "test", content: [{ type: "text", text: "result" }], isError: false, timestamp: 2 }] }), context);
    await agent.commit(tx => tx.appendEntry(agent.id, { kind: "test", model: [user("new")] }), context);
    await expect(call(agent, "context_checkpoint", { coveredThroughEntryId: pending.id, summary: "unsafe", expectedVersion: 0 })).rejects.toThrow();
    const view = await agent.context(context);
    const state = (await harness.snapshot(AgentContext, agent.id, context))!;
    expect(render(view.messages, state)).toEqual([...view.messages]);
    expect(view.messages.some(m => m.role === "toolResult" && m.toolCallId === "call-1")).toBe(true);
  } finally { await harness.close(context); await rm(dir, { recursive: true, force: true }); }
});
