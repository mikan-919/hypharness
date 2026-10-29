import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentDirectory, canClaimTask, type Role } from "../agents.ts";
import { OrganizationStore, type DelegationProposal } from "../organization.ts";
import { TaskBoard, addTask, newTask, touch, type Board } from "../tasks.ts";
import { DomainStore } from "../domains.ts";
import { GoalStore } from "../goals.ts";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const output = (x: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(x) }] });
type Directory = { ids: Partial<Record<Role, number>>; agents?: import("../agents.ts").AgentRecord[] };
function identity(directory: Directory, conversation: number) {
  const agent = directory.agents?.find(a => a.conversationId === String(conversation));
  if (!agent || agent.status !== "active" || !Object.values(directory.ids).includes(conversation)) throw new Error("Active registered agent required");
  return agent;
}
function validate(directory: Directory, board: Board, p: DelegationProposal) {
  const task = board.tasks.find(t => t.id === p.taskId);
  const target = directory.agents?.find(a => a.id === p.targetAgentId);
  const author = directory.agents?.find(a => a.id === p.author);
  if (!task || task.state !== "open" || task.revision !== p.taskRevision) throw new Error("Task unavailable or revision conflict");
  // Knowledge and administrative reviews retain their existing independent roles.
  if (!["subgoal", "hypothesis"].includes(task.type)) throw new Error("Task type cannot be delegated");
  if (!author || author.status !== "active" || !canClaimTask(directory, task, Number(author.conversationId))) throw new Error("Proposer cannot assign task");
  if (!target || target.status !== "active" || target.revision !== p.targetRevision || target.id === author.id || !Object.values(directory.ids).some(id => String(id) === target.conversationId)) throw new Error("Target unavailable or revision conflict");
}
const list = defineTool({ name: "agent_list", description: "List registered agents", parameters: Type.Object({}), execute: async (_a, api, ctx) => output((await api.snapshot(AgentDirectory, ctx))?.agents ?? []) });
const inspect = defineTool({ name: "agent_inspect", description: "Inspect a registered agent", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const agent = (await api.snapshot(AgentDirectory, ctx))?.agents?.find(x => x.id === a.id); if (!agent) throw new Error("Agent missing"); return output(agent); } });
const analyze = defineTool({ name: "organization_analyze", description: "Inspect measured organization workload without guessing model usage", parameters: Type.Object({}), execute: async (_a, api, ctx) => {
  const directory = await api.snapshot(AgentDirectory, ctx); identity(directory ?? { ids: {} }, api.conversationId);
  const board = await api.snapshot(TaskBoard, ctx); const domains = await api.snapshot(DomainStore, ctx); const goals = await api.snapshot(GoalStore, ctx);
  const agents = (directory?.agents ?? []).map(agent => ({ id: agent.id, status: agent.status, role: agent.role, capabilities: agent.capabilities, domainIds: (domains?.domains ?? []).filter(d => d.status === "active" && d.stewardId === agent.conversationId).map(d => d.id), goalIds: agent.goalIds, openTasks: (board?.tasks ?? []).filter(t => t.state === "open" && canClaimTask(directory!, t, Number(agent.conversationId))).length, claimedTasks: (board?.tasks ?? []).filter(t => t.state === "claimed" && t.owner === agent.conversationId).length }));
  const dormantAssignments = (board?.tasks ?? []).filter(t => t.state === "open" && t.assignedAgentId && agents.some(agent => agent.id === t.assignedAgentId && agent.status === "dormant")).map(t => t.id);
  return output({ decision: dormantAssignments.length ? "consider_resume" : "keep", reason: dormantAssignments.length ? "Open tasks are assigned to dormant agents; check reuse before creating an agent." : "No dormant assignments found; other change criteria are not evaluated.", activeAgents: agents.filter(a => a.status === "active").length, dormantAgents: agents.filter(a => a.status === "dormant").length, agents, openTasks: (board?.tasks ?? []).filter(t => t.state === "open").length, dormantAssignments, activeSubgoals: (goals?.goals ?? []).filter(g => g.id !== goals?.globalId && g.status === "active").length, modelCalls: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, inferenceCost: null });
} });
const propose = defineTool({ name: "agent_delegate", description: "Propose delegation of an unclaimed subgoal or hypothesis; independent review is required", parameters: Type.Object({ taskId: id, taskRevision: Type.Integer({ minimum: 0 }), targetAgentId: id, targetRevision: Type.Integer({ minimum: 0 }), reason: text, benefits: text, risks: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const author = identity(directory, api.conversationId);
  const board = await tx.doc(TaskBoard); const state = await tx.doc(OrganizationStore); const proposalId = `organization:${api.conversationId}:${api.callId}`;
  const existing = state.proposals.find(p => p.id === proposalId);
  if (existing) { if (JSON.stringify([existing.taskId, existing.taskRevision, existing.targetAgentId, existing.targetRevision, existing.reason, existing.benefits, existing.risks]) !== JSON.stringify([a.taskId, a.taskRevision, a.targetAgentId, a.targetRevision, a.reason, a.benefits, a.risks])) throw new Error("Proposal operation reused"); return proposalId; }
  const p: DelegationProposal = { id: proposalId, author: author.id, reviewer: null, ...a, status: "proposed", review: "", createdAt: api.now(), updatedAt: api.now() };
  validate(directory, board, p);
  const reviewer = (["author", "source_reviewer", "gist_reviewer"] as Role[]).find(role => directory.ids[role] !== undefined && directory.ids[role] !== api.conversationId && directory.agents?.some(agent => agent.conversationId === String(directory.ids[role]) && agent.status === "active"));
  if (!reviewer) throw new Error("Independent reviewer unavailable");
  state.proposals.push(p); addTask(board, newTask({ id: `review:${proposalId}`, type: "organization_review", description: proposalId, role: reviewer }, api.now())); return proposalId;
}, ctx)) });
const status = defineTool({ name: "organization_status", description: "Inspect an organization proposal", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const p = (await api.snapshot(OrganizationStore, ctx))?.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing"); return output(p); } });
const review = defineTool({ name: "organization_review", description: "Independently review a delegation proposal", parameters: Type.Object({ id, decision: Type.Union([Type.Literal("start"), Type.Literal("approve"), Type.Literal("reject")]), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const actor = identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (actor.id === p.author || (p.reviewer && p.reviewer !== actor.id)) throw new Error("Independent reviewer required");
  if (a.decision === "start" && p.status === "proposed") { p.reviewer = actor.id; p.status = "under_review"; }
  else if (a.decision !== "start" && p.status === "under_review") { if (a.decision === "approve") validate(directory, await tx.doc(TaskBoard), p); p.status = a.decision === "approve" ? "approved" : "rejected"; p.review = a.reason; }
  else if ((a.decision === "start" && p.status === "under_review") || (a.decision === "approve" && (p.status === "approved" || p.status === "applied")) || (a.decision === "reject" && p.status === "rejected")) return p.status;
  else throw new Error("Invalid review transition");
  p.updatedAt = api.now(); return p.status;
}, ctx)) });
const apply = defineTool({ name: "organization_apply", description: "Apply an independently approved delegation", parameters: Type.Object({ id }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (p.status === "applied") return p.status;
  if (p.status !== "approved" || !p.reviewer || p.reviewer === p.author) throw new Error("Independent approval required");
  const board = await tx.doc(TaskBoard); validate(directory, board, p); const task = board.tasks.find(t => t.id === p.taskId)!;
  task.assignedAgentId = p.targetAgentId; touch(task, api.now()); p.status = "applied"; p.updatedAt = api.now(); return p.status;
}, ctx)) });
export const OrganizationExtension = defineExtension({ name: "delm-organization", tools: [list, inspect, analyze, propose, status, review, apply] });
