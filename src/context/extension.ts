import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, GenerationTask, hook, type ConversationId, type Harness, type Tx } from "@earendil-works/pi-durable";
import { AgentDirectory } from "../agents.ts";
import { AgentContext, revise } from "./state.ts";
import { render, prefixHash } from "./renderer.ts";
import { syncMirror } from "./mirror.ts";

const str = Type.String({ maxLength: 65536 });
const version = Type.Integer({ minimum: 0 });
const editOperation = Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("delete")]);
const output = (data: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(data) }] });

export function createContextExtension(harness: Harness, mirrorRoot = "contexts") {
  const read = defineTool({ name: "context_read", description: "Read a bounded section of an agent context", parameters: Type.Object({ agentId: Type.Integer({ minimum: 0 }), section: Type.Optional(Type.Union([Type.Literal("workingMemory"), Type.Literal("checkpoint")])), maxChars: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), execute: async (args, api, context) => {
    const directory = await api.snapshot(AgentDirectory, context);
    const callerIsBase = Object.values(directory?.ids ?? {}).includes(api.conversationId);
    if (!callerIsBase && args.agentId !== api.conversationId) throw new Error("Dynamic agents can only read their own context");
    if (!directory?.agents?.some(agent => agent.conversationId === String(args.agentId))) throw new Error("Unknown agent");
    const state = await api.snapshot(AgentContext, args.agentId as ConversationId, context);
    if (!state) throw new Error("Context not initialized");
    const text = args.section === "checkpoint" ? state.checkpoint.summary : state.workingMemory;
    const offset = args.offset ?? 0, max = args.maxChars ?? 1024;
    return output({ agentId: args.agentId, version: state.version, section: args.section ?? "workingMemory", content: text.slice(offset, offset + max), offset, totalChars: text.length, truncated: offset + max < text.length });
  } });
  const edit = defineTool({ name: "context_edit", description: "Edit only your working memory; batch edits when possible", parameters: Type.Object({ operation: editOperation, content: str, expectedVersion: version, operationId: Type.String({ minLength: 1, maxLength: 200 }), edits: Type.Optional(Type.Array(Type.Object({ operation: editOperation, content: str }), { maxItems: 20 })) }), replay: "safe", execute: async (args, api, context) => {
    const result = await api.commit(async (tx: Tx) => {
      const state = await tx.doc(AgentContext, api.conversationId);
      const key = `edit:${args.operationId}`, fingerprint = JSON.stringify(args);
      const previous = state.operations[key];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Operation ID reused"); return previous.version; }
      const updated = revise(state, args.expectedVersion, "edit", args.operation, api.now(), () => {
        for (const edit of [{ operation: args.operation, content: args.content }, ...(args.edits ?? [])]) {
          if (edit.operation === "replace") state.workingMemory = edit.content;
          if (edit.operation === "append") state.workingMemory += edit.content;
          if (edit.operation === "delete") state.workingMemory = "";
        }
      });
      state.operations[key] = { fingerprint, version: updated };
      return updated;
    }, context);
    await syncMirror(harness, api.conversationId, context, mirrorRoot);
    return output({ version: result });
  } });
  const restore = defineTool({ name: "context_restore", description: "Restore a saved version of your context as a new version", parameters: Type.Object({ targetVersion: version, expectedVersion: version }), replay: "safe", execute: async (args, api, context) => {
    const result = await api.commit(async tx => {
      const state = await tx.doc(AgentContext, api.conversationId);
      const key = `restore:${api.callId}`, fingerprint = JSON.stringify(args);
      const previous = state.operations[key];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Operation ID reused"); return previous.version; }
      const target = state.history.find(item => item.version === args.targetVersion);
      if (!target) throw new Error("Version not available");
      const updated = revise(state, args.expectedVersion, "restore", `version ${args.targetVersion}`, api.now(), () => { state.workingMemory = target.workingMemory; state.checkpoint = { ...target.checkpoint }; }, true);
      state.operations[key] = { fingerprint, version: updated };
      return updated;
    }, context);
    await syncMirror(harness, api.conversationId, context, mirrorRoot);
    return output({ version: result });
  } });
  const history = defineTool({ name: "context_history", description: "List restorable versions of your context", parameters: Type.Object({}), execute: async (_args, api, context) => {
    const state = await api.snapshot(AgentContext, api.conversationId, context);
    return output((state?.history ?? []).map(({ version, operation, at, description }) => ({ version, operation, at, description, restorable: true })));
  } });
  const checkpoint = defineTool({ name: "context_checkpoint", description: "Summarize a completed conversation prefix; uncertain boundaries are rejected", parameters: Type.Object({ coveredThroughEntryId: Type.Integer({ minimum: 1 }), summary: Type.String({ minLength: 1, maxLength: 65536 }), expectedVersion: version }), replay: "safe", execute: async (args, api, context) => {
    const prior = (await api.snapshot(AgentContext, api.conversationId, context))?.operations[`checkpoint:${api.callId}`];
    if (prior) {
      if (prior.fingerprint !== JSON.stringify(args)) throw new Error("Operation ID reused");
      await syncMirror(harness, api.conversationId, context, mirrorRoot);
      return output({ version: prior.version });
    }
    const agent = await harness.conversation(api.conversationId, context);
    if (!agent) throw new Error("Conversation not found");
    const view = await agent.context(context);
    const entryIndex = view.entries.findIndex(entry => entry.id === args.coveredThroughEntryId);
    if (entryIndex < 0) throw new Error("Entry not in active conversation");
    const prefix = view.contributions.slice(0, entryIndex + 1).flat();
    const end = prefix.length;
    if (JSON.stringify(prefix) !== JSON.stringify(view.messages.slice(0, end))) throw new Error("Cannot safely map entries to model messages");
    let start = 0;
    while (view.messages[start]?.role === "system") start++;
    const covered = view.messages.slice(start, end), retained = view.messages.slice(end);
    if (!covered.length || !retained.some(m => m.role === "user") || covered.some(m => m.role === "system")) throw new Error("Unsafe checkpoint boundary");
    const last = covered.at(-1);
    if (last?.role !== "assistant" || last.stopReason !== "stop") throw new Error("Checkpoint must end at a completed assistant response");
    const open = new Set<string>();
    for (const message of covered) {
      if (message.role === "assistant") for (const item of message.content) if (item.type === "toolCall") open.add(item.id);
      if (message.role === "toolResult") { if (!open.delete(message.toolCallId)) throw new Error("Unmatched tool result"); }
    }
    if (open.size) throw new Error("Unfinished tool call");
    const result = await api.commit(async tx => {
      const state = await tx.doc(AgentContext, api.conversationId);
      const key = `checkpoint:${api.callId}`, fingerprint = JSON.stringify(args);
      const previous = state.operations[key];
      if (previous) { if (previous.fingerprint !== fingerprint) throw new Error("Operation ID reused"); return previous.version; }
      const updated = revise(state, args.expectedVersion, "checkpoint", `through ${args.coveredThroughEntryId}`, api.now(), () => { state.checkpoint = { coveredThroughEntryId: args.coveredThroughEntryId, summary: args.summary, prefixStart: start, prefixLength: covered.length, prefixHash: prefixHash(covered) }; });
      state.operations[key] = { fingerprint, version: updated };
      return updated;
    }, context);
    await syncMirror(harness, api.conversationId, context, mirrorRoot);
    return output({ version: result });
  } });
  return defineExtension({ name: "delm-context", tools: [read, edit, restore, history, checkpoint], hooks: [hook(GenerationTask, { beforeRequest: async (request, api, context) => {
    const state = await api.snapshot(AgentContext, api.conversationId, context);
    if (!state) return;
    const agent = await harness.conversation(api.conversationId, context);
    const model = agent ? (await agent.agent(context)).model : undefined;
    const limit = model ? api.models.getModel(model.provider, model.modelId)?.contextWindow : undefined;
    return { messages: render(request.messages, state, limit) };
  } })] });
}
