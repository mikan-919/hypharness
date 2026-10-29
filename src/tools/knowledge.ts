
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { KnowledgeStore } from "../knowledge.ts";
import { AgentDirectory } from "../agents.ts";
import { TaskBoard, owned, touch } from "../tasks.ts";
import { reviewTaskId } from "../workflow.ts";

const propose = defineTool({
  name: "knowledge_propose",
  description: "原資料、根拠付き要約、Gistを検証候補として登録する",
  parameters: Type.Object({
    raw: Type.String({ minLength: 1, maxLength: 12000 }),
    summary: Type.Array(Type.Object({
      claim: Type.String({ minLength: 1 }),
      quote: Type.String({ minLength: 1 }),
    }), { minItems: 1 }),
    gist: Type.String({ minLength: 1, maxLength: 1000 }),
    taskId: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 0 }),
  }),
  replay: "safe",

  execute: async (args, api, context) => {
    // 原資料に引用箇所が存在することだけは機械的に確認する
    for (const evidence of args.summary) {
      if (!args.raw.includes(evidence.quote)) {
        throw new Error(`引用が原資料に存在しません: ${evidence.quote}`);
      }
    }

    const id = `knowledge:${api.conversationId}:${api.callId}`;

    await api.commit(async (tx) => {
      const store = await tx.doc(KnowledgeStore);
      const board = await tx.doc(TaskBoard);
      const directory = await tx.doc(AgentDirectory);

      if (store.entries.some((entry) => entry.id === id)) return;
      if (directory.ids.author !== api.conversationId) throw new Error("Wrong author role");
      const task = board.tasks.find(t => t.id === args.taskId);
      if (!task || task.type !== "propose" || task.role !== "author" || task.description !== args.raw) throw new Error("Invalid proposal task");
      owned(task, String(api.conversationId), args.token, args.revision, api.now());

      store.entries.push({
        id,
        author: String(api.conversationId),
        raw: args.raw,
        summary: args.summary,
        gist: args.gist,
        status: "proposed",
      });
      task.state = "completed";
      task.knowledgeId = id;
      task.result = id;
      task.token = null;
      task.leaseUntil = null;
      touch(task, api.now());
    }, context);

    return { output: [{ type: "text", text: id }] };
  },
});

const review = defineTool({
  name: "knowledge_review",
  description: "別のエージェントとして知識の根拠またはGistを検証する",
  parameters: Type.Object({
    id: Type.String(),
    stage: Type.Union([
      Type.Literal("source"),
      Type.Literal("gist"),
    ]),
    approved: Type.Boolean(),
    reason: Type.String({ minLength: 1 }),
    token: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 0 }),
  }),
  replay: "safe",

  execute: async (args, api, context) => {
    const reviewer = String(api.conversationId);

    const status = await api.commit(async (tx) => {
      const store = await tx.doc(KnowledgeStore);
      const board = await tx.doc(TaskBoard);
      const directory = await tx.doc(AgentDirectory);
      const operationId = `review:${api.conversationId}:${api.callId}`;
      const fingerprint = JSON.stringify(args);
      const previous = board.operations[operationId];
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error("Review operation ID reused");
        return previous.result;
      }
      const role = args.stage === "source" ? "source_reviewer" : "gist_reviewer";
      if (directory.ids[role] !== api.conversationId) throw new Error("Wrong reviewer role");
      const task = board.tasks.find(t => t.id === reviewTaskId(args.id, args.stage));
      if (!task) throw new Error("Review task not found");
      owned(task, reviewer, args.token, args.revision, api.now());
      const entry = store.entries.find((e) => e.id === args.id);

      if (!entry) throw new Error("Knowledge not found");
      if (entry.author === reviewer) {
        throw new Error("投稿者自身による検証は禁止");
      }

      if (args.stage === "source") {
        if (entry.status !== "proposed") {
          throw new Error("Source review not allowed");
        }

        entry.sourceReviewer = reviewer;
        entry.status = args.approved ? "source_checked" : "rejected";
      } else {
        if (entry.status !== "source_checked") {
          throw new Error("Source review required");
        }
        if (entry.sourceReviewer === reviewer) {
          throw new Error("別の検証者が必要");
        }

        entry.gistReviewer = reviewer;
        entry.status = args.approved ? "verified" : "rejected";
      }

      entry.reviewNote = args.reason;
      task.state = "completed";
      task.result = args.reason;
      task.token = null;
      task.leaseUntil = null;
      touch(task, api.now());
      board.operations[operationId] = { fingerprint, result: entry.status };
      return entry.status;
    }, context);

    return {
      output: [{ type: "text", text: status }],
    };
  },
});

const unfold = defineTool({
  name: "knowledge_unfold",
  description: "知識のGist、根拠付き要約、原資料を段階的に読む",
  parameters: Type.Object({
    id: Type.String(),
    level: Type.Union([
      Type.Literal("gist"),
      Type.Literal("summary"),
      Type.Literal("raw"),
    ]),
  }),

  execute: async ({ id, level }, api, context) => {
    const store = await api.snapshot(KnowledgeStore, context);
    const entry = store?.entries.find((e) => e.id === id);

    if (!entry) throw new Error("Knowledge not found");

    const value = level === "raw"
      ? entry.raw
      : level === "summary"
        ? JSON.stringify(entry.summary)
        : entry.gist;

    return {
      output: [{ type: "text", text: value }],
    };
  },
});

const search = defineTool({
  name: "knowledge_search",
  description: "検証済みの共有知識をGistから探す",
  parameters: Type.Object({
    query: Type.String(),
  }),

  execute: async ({ query }, api, context) => {
    const store = await api.snapshot(KnowledgeStore, context);

    const results = (store?.entries ?? [])
      .filter((e) => e.status === "verified")
      .filter((e) =>
        e.gist.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, 10)
      .map(({ id, gist }) => ({ id, gist }));

    return {
      output: [{
        type: "text",
        text: JSON.stringify(results),
      }],
    };
  },
});

export const KnowledgeExtension = defineExtension({
  name: "delm-knowledge",
  tools: [propose, review, unfold, search],
});
