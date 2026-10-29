import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentDirectory, type Role } from "../agents.ts";
import { TaskBoard, addTask, checkCycles, newTask, operation, owned, ready, touch } from "../tasks.ts";
import { DomainStore } from "../domains.ts";
import { GoalStore } from "../goals.ts";

const roleSchema = Type.Union([Type.Literal("author"), Type.Literal("source_reviewer"), Type.Literal("gist_reviewer")]);
const text = Type.String({ minLength: 1, maxLength: 12000 });
const claim = { id: text, token: text, revision: Type.Integer({ minimum: 0 }), operationId: text };
const lease = Type.Integer({ minimum: 1000, maximum: 3600000 });
const output = (value: unknown) => ({ output: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }] });

const create = defineTool({ name: "task_create", description: "Create a task with existing dependencies", parameters: Type.Object({ id: text, type: text, description: text, role: roleSchema, dependencies: Type.Array(text), operationId: text }), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory);
  if (!Object.values(directory.ids).includes(api.conversationId)) throw new Error("Unregistered agent");
  const board = await tx.doc(TaskBoard); const now = api.now();
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["create", args]), () => { if (args.id.startsWith("review:") || args.type.startsWith("review_")) throw new Error("Review tasks are created by the workflow"); addTask(board, newTask(args, now)); return args.id; });
}, context)) });
const discover = defineTool({ name: "task_discover", description: "Find tasks available to your role", parameters: Type.Object({}), execute: async (_args, api, context) => {
  const directory = await api.snapshot(AgentDirectory, context); const board = await api.snapshot(TaskBoard, context);
  const role = Object.entries(directory?.ids ?? {}).find(([, id]) => id === api.conversationId)?.[0];
  if (!role) throw new Error("Unregistered agent");
  return output((board?.tasks ?? []).filter(t => t.role === role && ready(board!, t, api.now())));
} });
const claimTool = defineTool({ name: "task_claim", description: "Claim an available task using its current revision", parameters: Type.Object({ id: text, revision: Type.Integer({ minimum: 0 }), leaseMs: lease, operationId: text }), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const board = await tx.doc(TaskBoard); const now = api.now();
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["claim", args]), () => {
    const task = board.tasks.find(t => t.id === args.id); if (!task || directory.ids[task.role] !== api.conversationId || task.revision !== args.revision || !ready(board, task, now)) throw new Error("Task unavailable");
    task.state = "claimed"; task.owner = String(api.conversationId); task.token = crypto.randomUUID(); task.leaseUntil = now + args.leaseMs; touch(task, now); return JSON.stringify(task);
  });
}, context)) });
const heartbeat = defineTool({ name: "task_heartbeat", description: "Extend a current claim", parameters: Type.Object({ ...claim, leaseMs: lease }), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const board = await tx.doc(TaskBoard); const now = api.now();
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["heartbeat", args]), () => { const task = board.tasks.find(t => t.id === args.id); if (!task) throw new Error("Task missing"); owned(task, String(api.conversationId), args.token, args.revision, now); task.leaseUntil = now + args.leaseMs; touch(task, now); return JSON.stringify(task); });
}, context)) });
const release = defineTool({ name: "task_release", description: "Release a current claim", parameters: Type.Object(claim), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const board = await tx.doc(TaskBoard); const now = api.now();
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["release", args]), () => { const task = board.tasks.find(t => t.id === args.id); if (!task) throw new Error("Task missing"); owned(task, String(api.conversationId), args.token, args.revision, now); task.state = "open"; task.owner = null; task.token = null; task.leaseUntil = null; touch(task, now); return JSON.stringify(task); });
}, context)) });
const finish = defineTool({ name: "task_finish", description: "Finish a current task", parameters: Type.Object({ ...claim, result: text, failed: Type.Boolean() }), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const board = await tx.doc(TaskBoard); const now = api.now();
  const current = board.tasks.find(t => t.id === args.id);
  if (current && !args.failed && current.type === "domain_review") { const proposals = await tx.doc(DomainStore); const proposal = proposals.proposals.find(p => p.id === current.description); if (!proposal || (proposal.status !== "applied" && proposal.status !== "rejected")) throw new Error("Domain review is not resolved"); }
  if (current && !args.failed && current.type === "goal_review") { const proposals = await tx.doc(GoalStore); const proposal = proposals.proposals.find(p => p.id === current.description); if (!proposal || (proposal.status !== "applied" && proposal.status !== "rejected")) throw new Error("Goal review is not resolved"); }
  if (current && !args.failed && current.type === "discovery_feedback") { const domains = await tx.doc(DomainStore); const discovery = domains.discoveries.find(d => d.id === current.description); if (!discovery || discovery.outcome === "pending") throw new Error("Discovery outcome is not recorded"); }
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["finish", args]), () => { const task = board.tasks.find(t => t.id === args.id); if (!task) throw new Error("Task missing"); owned(task, String(api.conversationId), args.token, args.revision, now); if (!args.failed && (task.type.startsWith("review_") || task.type === "propose")) throw new Error("Finish knowledge tasks using the knowledge tools"); task.state = args.failed ? "failed" : "completed"; task.result = args.result; task.token = null; task.leaseUntil = null; touch(task, now); return JSON.stringify(task); });
}, context)) });
const split = defineTool({ name: "task_split", description: "Replace a claimed task with child tasks", parameters: Type.Object({ ...claim, children: Type.Array(Type.Object({ id: text, type: text, description: text, role: roleSchema, dependencies: Type.Array(text) }), { minItems: 1, maxItems: 20 }) }), replay: "safe", execute: async (args, api, context) => output(await api.commit(async tx => {
  const board = await tx.doc(TaskBoard); const now = api.now();
  return operation(board, `${api.conversationId}:${args.operationId}`, JSON.stringify(["split", args]), () => { const task = board.tasks.find(t => t.id === args.id); if (!task) throw new Error("Task missing"); owned(task, String(api.conversationId), args.token, args.revision, now); if (task.type.startsWith("review_") || task.type === "propose") throw new Error("Knowledge tasks cannot be split"); for (const child of args.children) { if (child.id.startsWith("review:") || child.type.startsWith("review_")) throw new Error("Review tasks are created by the workflow"); addTask(board, newTask({ ...child, parent: task.id, knowledgeId: task.knowledgeId }, now)); } task.state = "split"; checkCycles(board); task.token = null; task.leaseUntil = null; touch(task, now); return JSON.stringify(task); });
}, context)) });
const status = defineTool({ name: "task_status", description: "Read task status", parameters: Type.Object({ id: text }), execute: async (args, api, context) => output((await api.snapshot(TaskBoard, context))?.tasks.find(t => t.id === args.id) ?? null) });
export const TaskExtension = defineExtension({ name: "delm-tasks", tools: [create, discover, claimTool, heartbeat, release, finish, split, status] });
