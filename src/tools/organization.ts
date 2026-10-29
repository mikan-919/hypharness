import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentDirectory, canClaimTask, type Role } from "../agents.ts";
import { OrganizationStore, type DelegationProposal, type SpawnProposal } from "../organization.ts";
import { TaskBoard, addTask, newTask, touch, type Board } from "../tasks.ts";
import { DomainStore, type DomainState } from "../domains.ts";
import { GoalStore, type GoalState } from "../goals.ts";
import { AgentContext } from "../context/state.ts";

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
function validateSpawn(directory: Directory, board: Board, domains: DomainState, goals: GoalState, p: SpawnProposal) {
  const author = directory.agents?.find(agent => agent.id === p.author);
  const task = board.tasks.find(task => task.id === p.taskId);
  if (!author || author.status !== "active" || !task || task.state !== "open" || task.revision !== p.taskRevision || !canClaimTask(directory, task, Number(author.conversationId))) throw new Error("Task unavailable or revision conflict");
  if (task.type !== "subgoal") throw new Error("Task type cannot be assigned to a new agent");
  if (!task.requiredSpecialty || task.requiredSpecialty.trim().toLowerCase() !== p.role.trim().toLowerCase()) throw new Error("Task does not require the proposed specialty");
  if (!p.name.trim() || !p.role.trim() || !p.reason.trim() || !p.reuseReason.trim() || !p.benefits.trim() || !p.costs.trim() || !p.risks.trim()) throw new Error("Spawn rationale is required");
  if (!p.capabilities.includes("research") || !p.capabilities.includes("task_management") || p.capabilities.some(capability => !["research", "task_management"].includes(capability)) || new Set(p.capabilities).size !== p.capabilities.length) throw new Error("Invalid dynamic agent capabilities");
  if (directory.agents?.some(agent => ["active", "dormant", "initializing", "recovering"].includes(agent.status) && agent.role.trim().toLowerCase() === p.role.trim().toLowerCase())) throw new Error("Existing agent can be reused for this role");
  if (!goals.globalId || !goals.goals.some(goal => goal.id === goals.globalId && goal.status === "active")) throw new Error("Global goal required");
  if (new Set(p.initialGoalIds).size !== p.initialGoalIds.length || new Set(p.initialDomainIds).size !== p.initialDomainIds.length) throw new Error("Duplicate assignments");
  for (const id of p.initialGoalIds) { const goal = goals.goals.find(goal => goal.id === id && goal.status === "active"); if (!goal || goal.revision !== p.goalRevisions[id]) throw new Error("Goal revision conflict"); }
  for (const id of p.initialDomainIds) { const domain = domains.domains.find(domain => domain.id === id && domain.status === "active"); if (!domain || domain.revision !== p.domainRevisions[id]) throw new Error("Domain revision conflict"); }
  if (task.goalId && !p.initialGoalIds.includes(task.goalId)) throw new Error("Task goal must be assigned");
}
function checkSpawnBudget(directory: Directory, run: import("../organization.ts").OrganizationRun | undefined) {
  if (!run || run.round >= run.limits.maxOrganizationRounds || run.spawns >= run.limits.maxSpawnsPerRun || run.roundSpawns >= run.limits.maxSpawnsPerRound || run.roundChanges >= run.limits.maxOrganizationChangesPerRound) throw new Error("Organization budget exhausted");
  if ((directory.agents ?? []).filter(agent => ["active", "initializing", "recovering"].includes(agent.status)).length >= run.limits.maxActiveAgents) throw new Error("Active agent limit reached");
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
const spawnPropose = defineTool({ name: "organization_propose", description: "Propose a specialist for an open task; explain why existing agents cannot be reused", parameters: Type.Object({ name: id, role: id, capabilities: Type.Array(Type.Union([Type.Literal("research"), Type.Literal("task_management")]), { minItems: 2, maxItems: 2 }), initialGoalIds: Type.Array(id, { maxItems: 16 }), initialDomainIds: Type.Array(id, { maxItems: 16 }), taskId: id, taskRevision: Type.Integer({ minimum: 0 }), domainRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), goalRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), reason: text, reuseReason: text, benefits: text, costs: text, risks: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const author = identity(directory, api.conversationId); const board = await tx.doc(TaskBoard); const state = await tx.doc(OrganizationStore); const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore);
  const proposalId = `spawn:${api.conversationId}:${api.callId}`; state.spawnProposals ??= [];
  const old = state.spawnProposals.find(p => p.id === proposalId);
  if (old) { const { id: _id, author: _author, reviewer: _reviewer, status: _status, review: _review, createdAt: _created, updatedAt: _updated, agentId: _agent, ...input } = old; if (JSON.stringify(input) !== JSON.stringify(a)) throw new Error("Proposal operation reused"); return proposalId; }
  const p: SpawnProposal = { id: proposalId, author: author.id, reviewer: null, status: "proposed", ...a, review: "", createdAt: api.now(), updatedAt: api.now(), agentId: null };
  validateSpawn(directory, board, domains, goals, p); checkSpawnBudget(directory, state.run);
  const reviewer = (["author", "source_reviewer", "gist_reviewer"] as Role[]).find(role => directory.ids[role] !== undefined && directory.ids[role] !== api.conversationId && directory.agents?.some(agent => agent.conversationId === String(directory.ids[role]) && agent.status === "active"));
  if (!reviewer) throw new Error("Independent reviewer unavailable");
  state.spawnProposals.push(p); addTask(board, newTask({ id: `review:${proposalId}`, type: "organization_review", description: proposalId, role: reviewer }, api.now())); return proposalId;
}, ctx)) });
const status = defineTool({ name: "organization_status", description: "Inspect an organization proposal", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const state = await api.snapshot(OrganizationStore, ctx); const p = state?.proposals.find(p => p.id === a.id) ?? state?.spawnProposals?.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing"); return output(p); } });
const review = defineTool({ name: "organization_review", description: "Independently review a delegation proposal", parameters: Type.Object({ id, decision: Type.Union([Type.Literal("start"), Type.Literal("approve"), Type.Literal("reject")]), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const actor = identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const spawn = state.spawnProposals?.find(p => p.id === a.id); const p = spawn ?? state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (actor.id === p.author || (p.reviewer && p.reviewer !== actor.id)) throw new Error("Independent reviewer required");
  if (a.decision === "start" && p.status === "proposed") { p.reviewer = actor.id; p.status = "under_review"; }
  else if (a.decision !== "start" && p.status === "under_review") { if (a.decision === "approve") { if (spawn) { validateSpawn(directory, await tx.doc(TaskBoard), await tx.doc(DomainStore), await tx.doc(GoalStore), spawn); checkSpawnBudget(directory, state.run); } else validate(directory, await tx.doc(TaskBoard), p as DelegationProposal); } p.status = a.decision === "approve" ? "approved" : "rejected"; p.review = a.reason; }
  else if ((a.decision === "start" && p.status === "under_review") || (a.decision === "approve" && (p.status === "approved" || p.status === "applied")) || (a.decision === "reject" && p.status === "rejected")) return p.status;
  else throw new Error("Invalid review transition");
  p.updatedAt = api.now(); return p.status;
}, ctx)) });
const apply = defineTool({ name: "organization_apply", description: "Apply an independently approved delegation", parameters: Type.Object({ id }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const spawn = state.spawnProposals?.find(p => p.id === a.id); const p = spawn ?? state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (p.status === "applied") return p.status;
  if (p.status !== "approved" || !p.reviewer || p.reviewer === p.author) throw new Error("Independent approval required");
  const board = await tx.doc(TaskBoard);
  if (spawn) {
    const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore); const source = await tx.doc(AgentDoc, api.conversationId); const sourceContext = await tx.doc(AgentContext, api.conversationId);
    validateSpawn(directory, board, domains, goals, spawn); checkSpawnBudget(directory, state.run);
    const global = goals.goals.find(goal => goal.id === goals.globalId)!;
    const summary = spawn.initialDomainIds.map(id => { const domain = domains.domains.find(d => d.id === id)!; return `${domain.name}: ${domain.description.slice(0, 300)}`; }).join("; ");
    const subgoals = spawn.initialGoalIds.map(id => goals.goals.find(g => g.id === id)!.description.slice(0, 300)).join("; ");
    const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
    await configure(tx, conversation.id, { ...(source.model ? { model: source.model } : {}), instructions: `最上位目的: ${global.description}\n役割: ${spawn.role}\n領域: ${summary}\n下位目標: ${subgoals}\n共有記憶と知識を参照し、タスクを取得してから作業する。最上位目的を変更しない。` });
    (await tx.doc(AgentContext, conversation.id)).budget = { ...sourceContext.budget };
    const agentId = `agent:${spawn.id}`; const now = api.now();
    directory.agents!.push({ id: agentId, conversationId: String(conversation.id), name: spawn.name, role: spawn.role, capabilities: [...spawn.capabilities], status: "active", domainIds: [...spawn.initialDomainIds], goalIds: [...spawn.initialGoalIds], parentAgentId: spawn.author, createdAt: now, updatedAt: now, lastActiveAt: null, revision: 0 });
    const task = board.tasks.find(t => t.id === spawn.taskId)!; task.assignedAgentId = agentId; touch(task, now);
    state.run!.spawns++; state.run!.roundSpawns++; state.run!.roundChanges++; spawn.agentId = agentId; spawn.status = "applied"; spawn.updatedAt = now; return spawn.status;
  }
  if (state.run && (state.run.round >= state.run.limits.maxOrganizationRounds || state.run.roundChanges >= state.run.limits.maxOrganizationChangesPerRound)) throw new Error("Organization budget exhausted");
  const delegation = p as DelegationProposal; validate(directory, board, delegation); const task = board.tasks.find(t => t.id === delegation.taskId)!;
  task.assignedAgentId = delegation.targetAgentId; touch(task, api.now()); if (state.run) state.run.roundChanges++; delegation.status = "applied"; delegation.updatedAt = api.now(); return delegation.status;
}, ctx)) });
const spawn = defineTool({ name: "agent_spawn", description: "Apply an independently approved organization proposal", parameters: Type.Object({ id }), replay: "safe", execute: apply.execute });
export const OrganizationExtension = defineExtension({ name: "delm-organization", tools: [list, inspect, analyze, propose, spawnPropose, status, review, apply, spawn] });
