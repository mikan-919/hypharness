import { Type } from "@earendil-works/pi-ai";
import { AgentDoc, configure, defineExtension, defineTool, type ConversationId } from "@earendil-works/pi-durable";
import { AgentDirectory, canClaimTask, transitionAgent, type Role } from "../agents.ts";
import { OrganizationConflict, OrganizationDeferred, OrganizationStore, type DelegationProposal, type HandoffProposal, type LifecycleProposal, type SpawnProposal } from "../organization.ts";
import { TaskBoard, addTask, newTask, touch, type Board } from "../tasks.ts";
import { DomainStore, type DomainState } from "../domains.ts";
import { GoalStore, type GoalState } from "../goals.ts";
import { AgentContext } from "../context/state.ts";
import { estimate } from "../context/state.ts";
import { KnowledgeStore } from "../knowledge.ts";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const output = (x: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(x) }] });
type Directory = { ids: Partial<Record<Role, number>>; agents?: import("../agents.ts").AgentRecord[] };
function identity(directory: Directory, conversation: number) {
  const agent = directory.agents?.find(a => a.conversationId === String(conversation));
  if (!agent || agent.status !== "active" || !Object.values(directory.ids).includes(conversation)) throw new Error("Active registered agent required");
  return agent;
}
function identityAny(directory: Directory, conversation: number) {
  const agent = directory.agents?.find(a => a.conversationId === String(conversation));
  if (!agent || agent.status !== "active" || (!Object.values(directory.ids).includes(conversation) && !agent.capabilities.includes("task_management"))) throw new Error("Active registered agent required");
  return agent;
}
function validate(directory: Directory, board: Board, p: DelegationProposal) {
  const task = board.tasks.find(t => t.id === p.taskId);
  const target = directory.agents?.find(a => a.id === p.targetAgentId);
  const author = directory.agents?.find(a => a.id === p.author);
  if (!task || task.state !== "open" || task.revision !== p.taskRevision) throw new OrganizationConflict("Task unavailable or revision conflict");
  // Knowledge and administrative reviews retain their existing independent roles.
  if (!["subgoal", "hypothesis"].includes(task.type)) throw new OrganizationConflict("Task type cannot be delegated");
  if (!author || author.status !== "active" || !canClaimTask(directory, task, Number(author.conversationId))) throw new OrganizationConflict("Proposer cannot assign task");
  if (!target || target.status !== "active" || target.revision !== p.targetRevision || target.id === author.id || !Object.values(directory.ids).some(id => String(id) === target.conversationId)) throw new OrganizationConflict("Target unavailable or revision conflict");
}
function validateSpawn(directory: Directory, board: Board, domains: DomainState, goals: GoalState, p: SpawnProposal) {
  const author = directory.agents?.find(agent => agent.id === p.author);
  const task = board.tasks.find(task => task.id === p.taskId);
  if (!author || author.status !== "active" || !task || task.state !== "open" || task.revision !== p.taskRevision || !canClaimTask(directory, task, Number(author.conversationId))) throw new OrganizationConflict("Task unavailable or revision conflict");
  if (task.type !== "subgoal") throw new OrganizationConflict("Task type cannot be assigned to a new agent");
  if (!task.requiredSpecialty || task.requiredSpecialty.trim().toLowerCase() !== p.role.trim().toLowerCase()) throw new OrganizationConflict("Task does not require the proposed specialty");
  if (!p.name.trim() || !p.role.trim() || !p.reason.trim() || !p.reuseReason.trim() || !p.benefits.trim() || !p.costs.trim() || !p.risks.trim()) throw new OrganizationConflict("Spawn rationale is required");
  if (!p.capabilities.includes("research") || !p.capabilities.includes("task_management") || p.capabilities.some(capability => !["research", "task_management"].includes(capability)) || new Set(p.capabilities).size !== p.capabilities.length) throw new OrganizationConflict("Invalid dynamic agent capabilities");
  if (directory.agents?.some(agent => ["active", "dormant", "initializing", "recovering"].includes(agent.status) && agent.role.trim().toLowerCase() === p.role.trim().toLowerCase())) throw new OrganizationConflict("Existing agent can be reused for this role");
  if (!goals.globalId || !goals.goals.some(goal => goal.id === goals.globalId && goal.status === "active")) throw new OrganizationConflict("Global goal required");
  if (new Set(p.initialGoalIds).size !== p.initialGoalIds.length || new Set(p.initialDomainIds).size !== p.initialDomainIds.length) throw new OrganizationConflict("Duplicate assignments");
  for (const id of p.initialGoalIds) { const goal = goals.goals.find(goal => goal.id === id && goal.status === "active"); if (!goal || goal.revision !== p.goalRevisions[id]) throw new OrganizationConflict("Goal revision conflict"); }
  for (const id of p.initialDomainIds) { const domain = domains.domains.find(domain => domain.id === id && domain.status === "active"); if (!domain || domain.revision !== p.domainRevisions[id]) throw new OrganizationConflict("Domain revision conflict"); }
  if (task.goalId && !p.initialGoalIds.includes(task.goalId)) throw new OrganizationConflict("Task goal must be assigned");
}
function checkSpawnBudget(directory: Directory, run: import("../organization.ts").OrganizationRun | undefined) {
  if (!run || run.round >= run.limits.maxOrganizationRounds || run.spawns >= run.limits.maxSpawnsPerRun || run.roundSpawns >= run.limits.maxSpawnsPerRound || run.roundChanges >= run.limits.maxOrganizationChangesPerRound) throw new OrganizationDeferred("Organization budget exhausted");
  checkCapacity(directory, run);
}
function checkCapacity(directory: Directory, run: import("../organization.ts").OrganizationRun) { if ((directory.agents ?? []).filter(agent => ["active", "initializing", "recovering"].includes(agent.status)).length >= run.limits.maxActiveAgents) throw new OrganizationDeferred("Active agent limit reached"); }
function checkChangeBudget(run: import("../organization.ts").OrganizationRun | undefined) {
  if (!run || run.round >= run.limits.maxOrganizationRounds || run.roundChanges >= run.limits.maxOrganizationChangesPerRound) throw new OrganizationDeferred("Organization budget exhausted");
}
function validateLifecycle(directory: Directory, board: Board, domains: DomainState, proposal: LifecycleProposal, now: number, handoffs: HandoffProposal[] = [], goals?: GoalState) {
  const agent = directory.agents?.find(a => a.id === proposal.agentId);
  if (!agent || agent.revision !== proposal.agentRevision) throw new OrganizationConflict("Agent revision conflict");
  if (Object.values(directory.ids).some(id => String(id) === agent.conversationId)) throw new OrganizationConflict("Base agents are protected");
  if (now < agent.updatedAt + 60000) throw new OrganizationDeferred("Agent is in cooldown");
  if (proposal.kind === "retire") {
    if (agent.status !== "active") throw new OrganizationConflict("Active agent required");
    if (board.tasks.some(task => (task.state === "open" && task.assignedAgentId === agent.id) || (task.state === "claimed" && task.owner === agent.conversationId))) throw new OrganizationConflict("Agent has unfinished tasks");
    if (handoffs.some(p => p.fromAgentId === agent.id && ["proposed", "under_review", "approved"].includes(p.status))) throw new OrganizationConflict("Agent has an unfinished handoff");
    if (domains.domains.some(domain => domain.status === "active" && domain.stewardId === agent.conversationId)) throw new OrganizationConflict("Agent is a domain steward");
  } else if (proposal.kind === "reuse") { if (agent.status !== "dormant") throw new OrganizationConflict("Dormant agent required"); }
  else {
    if (agent.status !== "active" || !proposal.newRole?.trim() || proposal.newRole === agent.role) throw new OrganizationConflict("Invalid role reassignment");
    if (directory.agents?.some(other => other.id !== agent.id && ["active", "dormant"].includes(other.status) && other.role.trim().toLowerCase() === proposal.newRole!.trim().toLowerCase())) throw new OrganizationConflict("Existing agent can be reused for this role");
    if (board.tasks.some(task => (task.state === "claimed" && task.owner === agent.conversationId) || (task.state === "open" && task.assignedAgentId === agent.id && task.requiredSpecialty && task.requiredSpecialty.trim().toLowerCase() !== proposal.newRole!.trim().toLowerCase()))) throw new OrganizationConflict("Agent has incompatible tasks");
    if (!goals?.globalId || !proposal.goalRevisions || !proposal.domainRevisions) throw new OrganizationConflict("Goal and domain revisions required");
    for (const [id, revision] of Object.entries(proposal.goalRevisions)) if (!goals.goals.some(goal => goal.id === id && goal.status === "active" && goal.revision === revision)) throw new OrganizationConflict("Goal revision conflict");
    for (const [id, revision] of Object.entries(proposal.domainRevisions)) if (!domains.domains.some(domain => domain.id === id && domain.status === "active" && domain.revision === revision)) throw new OrganizationConflict("Domain revision conflict");
  }
  return agent;
}
function validateHandoff(directory: Directory, board: Board, domains: DomainState, goals: GoalState, p: HandoffProposal) {
  const from = directory.agents?.find(agent => agent.id === p.fromAgentId); const to = directory.agents?.find(agent => agent.id === p.toAgentId);
  if (!from || from.id !== p.author || from.status !== "active" || from.revision !== p.fromRevision || !to || to.id === from.id || to.status !== "active" || to.revision !== p.toRevision) throw new OrganizationConflict("Handoff agent unavailable or revision conflict");
  const targetBase = Object.values(directory.ids).some(id => String(id) === to.conversationId);
  if (!targetBase && !to.capabilities.includes("task_management")) throw new OrganizationConflict("Handoff target cannot execute tasks");
  for (const ids of [p.taskIds, p.domainIds, p.goalIds, p.knowledgeIds]) if (new Set(ids).size !== ids.length) throw new OrganizationConflict("Duplicate handoff IDs");
  for (const id of p.taskIds) { const task = board.tasks.find(t => t.id === id); if (!task || task.state !== "open" || task.revision !== p.taskRevisions[id] || !canClaimTask(directory, task, Number(from.conversationId)) || !["subgoal", "hypothesis"].includes(task.type) || (!targetBase && task.type !== "subgoal")) throw new OrganizationConflict("Handoff task unavailable or revision conflict"); }
  for (const id of p.domainIds) { const domain = domains.domains.find(d => d.id === id && d.status === "active"); if (!domain || domain.revision !== p.domainRevisions[id] || domain.stewardId !== from.conversationId || !targetBase) throw new OrganizationConflict("Handoff domain unavailable or revision conflict"); }
  for (const id of p.goalIds) { const goal = goals.goals.find(g => g.id === id && g.status === "active"); if (!goal || goal.revision !== p.goalRevisions[id] || !from.goalIds.includes(id)) throw new OrganizationConflict("Handoff goal unavailable or revision conflict"); }
  if (p.kind === "consolidate") {
    if (Object.values(directory.ids).some(id => String(id) === from.conversationId)) throw new OrganizationConflict("Base agents are protected");
    if (!targetBase && !from.capabilities.some(capability => to.capabilities.includes(capability))) throw new OrganizationConflict("Agent roles do not overlap");
    if (board.tasks.some(task => (task.state === "claimed" && task.owner === from.conversationId) || (task.state === "open" && task.assignedAgentId === from.id && !p.taskIds.includes(task.id)))) throw new OrganizationConflict("Consolidation has unfinished tasks");
    if (domains.domains.some(domain => domain.status === "active" && domain.stewardId === from.conversationId && !p.domainIds.includes(domain.id))) throw new OrganizationConflict("Consolidation has untransferred domains");
    if (from.goalIds.some(id => !p.goalIds.includes(id))) throw new OrganizationConflict("Consolidation has untransferred goals");
  } else if (!p.taskIds.length && !p.domainIds.length && !p.goalIds.length) throw new OrganizationConflict("Empty handoff");
  return { from, to };
}
const list = defineTool({ name: "agent_list", description: "List registered agents", parameters: Type.Object({}), execute: async (_a, api, ctx) => output((await api.snapshot(AgentDirectory, ctx))?.agents ?? []) });
const inspect = defineTool({ name: "agent_inspect", description: "Inspect a registered agent", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const agent = (await api.snapshot(AgentDirectory, ctx))?.agents?.find(x => x.id === a.id); if (!agent) throw new Error("Agent missing"); return output(agent); } });
const analyze = defineTool({ name: "organization_analyze", description: "Inspect measured organization workload without guessing model usage", parameters: Type.Object({}), execute: async (_a, api, ctx) => {
  const directory = await api.snapshot(AgentDirectory, ctx); const author = identity(directory ?? { ids: {} }, api.conversationId);
  const board = await api.snapshot(TaskBoard, ctx); const domains = await api.snapshot(DomainStore, ctx); const goals = await api.snapshot(GoalStore, ctx);
  const agents = await Promise.all((directory?.agents ?? []).map(async agent => { const id = Number(agent.conversationId); if (!Number.isSafeInteger(id) || id < 0 || String(id) !== agent.conversationId) throw new Error("Invalid conversation ID"); const context = await api.snapshot(AgentContext, id as ConversationId, ctx); return { id: agent.id, status: agent.status, role: agent.role, capabilities: agent.capabilities, domainIds: (domains?.domains ?? []).filter(d => d.status === "active" && d.stewardId === agent.conversationId).map(d => d.id), goalIds: agent.goalIds, openTasks: (board?.tasks ?? []).filter(t => t.state === "open" && canClaimTask(directory!, t, id)).length, claimedTasks: (board?.tasks ?? []).filter(t => t.state === "claimed" && t.owner === agent.conversationId).length, contextBytes: context ? estimate(context.workingMemory) + estimate(context.checkpoint.summary) : null }; }));
  const dormantAssignments = (board?.tasks ?? []).filter(t => t.state === "open" && t.assignedAgentId && agents.some(agent => agent.id === t.assignedAgentId && agent.status === "dormant")).map(t => t.id);
  const specialized = (board?.tasks ?? []).filter(t => t.state === "open" && t.requiredSpecialty);
  const dormantMatches = specialized.filter(t => agents.some(agent => agent.status === "dormant" && agent.role.trim().toLowerCase() === t.requiredSpecialty!.trim().toLowerCase()));
  const activeMatches = specialized.filter(t => agents.some(agent => agent.status === "active" && agent.role.trim().toLowerCase() === t.requiredSpecialty!.trim().toLowerCase() && !canClaimTask(directory!, t, Number(directory!.agents!.find(a => a.id === agent.id)!.conversationId))));
  const unmatched = specialized.filter(t => !agents.some(agent => ["active", "dormant"].includes(agent.status) && agent.role.trim().toLowerCase() === t.requiredSpecialty!.trim().toLowerCase()));
  const decision = activeMatches.length ? "consider_reassign" : dormantAssignments.length || dormantMatches.length ? "consider_resume" : unmatched.length ? "consider_specialist" : "keep";
  const reason = decision === "consider_reassign" ? "An open task matches an active specialist; evaluate reassignment." : decision === "consider_resume" ? "An open task matches a dormant agent; evaluate reuse." : decision === "consider_specialist" ? "An open task names a specialty with no matching active or dormant role; independently review the need and alternatives." : "No uncovered specialty or dormant assignment was found.";
  const taskIds = [...new Set([...activeMatches.map(t => t.id), ...dormantAssignments, ...dormantMatches.map(t => t.id), ...unmatched.map(t => t.id)])];
  await api.commit(async tx => { const state = await tx.doc(OrganizationStore); state.analyses ??= []; const id = `analysis:${api.conversationId}:${api.callId}`; if (!state.analyses.some(a => a.id === id)) { state.analyses.push({ id, author: author.id, decision, reason, taskIds, at: api.now() }); if (state.analyses.length > 100) state.analyses.splice(0, state.analyses.length - 100); } }, ctx);
  return output({ decision, reason, taskIds, activeAgents: agents.filter(a => a.status === "active").length, dormantAgents: agents.filter(a => a.status === "dormant").length, agents, openTasks: (board?.tasks ?? []).filter(t => t.state === "open").length, failedTasks: (board?.tasks ?? []).filter(t => t.state === "failed").length, dormantAssignments, activeSubgoals: (goals?.goals ?? []).filter(g => g.id !== goals?.globalId && g.status === "active").length, pendingDiscoveries: (domains?.discoveries ?? []).filter(d => d.outcome === "pending").length, modelCalls: null, inputTokens: null, outputTokens: null, cachedInputTokens: null, inferenceCost: null, utilization: null, taskProcessingTime: null, taskRetries: null });
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
function lifecycleTool(kind: "retire" | "reuse" | "reassign") {
  return defineTool({ name: `agent_${kind}`, description: `Propose ${kind} of a dynamic agent; independent review is required`, parameters: Type.Object({ agentId: id, agentRevision: Type.Integer({ minimum: 0 }), newRole: Type.Optional(id), reason: text, benefits: text, risks: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
    const directory = await tx.doc(AgentDirectory); const author = identity(directory, api.conversationId); const board = await tx.doc(TaskBoard); const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore); const state = await tx.doc(OrganizationStore); state.lifecycleProposals ??= [];
    const proposalId = `${kind}:${api.conversationId}:${api.callId}`; const old = state.lifecycleProposals.find(p => p.id === proposalId);
    if (old) { if (JSON.stringify([old.agentId, old.agentRevision, old.newRole, old.reason, old.benefits, old.risks]) !== JSON.stringify([a.agentId, a.agentRevision, a.newRole, a.reason, a.benefits, a.risks])) throw new Error("Proposal operation reused"); return proposalId; }
    if (kind !== "reassign" && a.newRole !== undefined) throw new Error("Role is only valid for reassignment");
    const p: LifecycleProposal = { id: proposalId, author: author.id, reviewer: null, status: "proposed", kind, ...a, review: "", createdAt: api.now(), updatedAt: api.now() };
    if (kind === "reassign") { const target = directory.agents?.find(agent => agent.id === p.agentId); if (!target || !goals.globalId) throw new Error("Agent and global goal required"); p.goalRevisions = Object.fromEntries([...new Set([goals.globalId, ...target.goalIds])].map(id => { const goal = goals.goals.find(g => g.id === id && g.status === "active"); if (!goal) throw new Error("Active goal missing"); return [id, goal.revision]; })); p.domainRevisions = Object.fromEntries(target.domainIds.map(id => { const domain = domains.domains.find(d => d.id === id && d.status === "active"); if (!domain) throw new Error("Active domain missing"); return [id, domain.revision]; })); }
    validateLifecycle(directory, board, domains, p, api.now(), state.handoffs, goals); checkChangeBudget(state.run); if (kind === "reuse") checkCapacity(directory, state.run!);
    const reviewer = (["author", "source_reviewer", "gist_reviewer"] as Role[]).find(role => directory.ids[role] !== undefined && directory.ids[role] !== api.conversationId && directory.agents?.some(agent => agent.conversationId === String(directory.ids[role]) && agent.status === "active"));
    if (!reviewer) throw new Error("Independent reviewer unavailable");
    state.lifecycleProposals.push(p); addTask(board, newTask({ id: `review:${proposalId}`, type: "organization_review", description: proposalId, role: reviewer }, api.now())); return proposalId;
  }, ctx)) });
}
const retire = lifecycleTool("retire");
const reuse = lifecycleTool("reuse");
const reassign = lifecycleTool("reassign");
function handoffTool(kind: "handoff" | "consolidate") { return defineTool({ name: `agent_${kind}`, description: "Propose a handoff of your open tasks and responsibilities; release claimed tasks first", parameters: Type.Object({ toAgentId: id, fromRevision: Type.Integer({ minimum: 0 }), toRevision: Type.Integer({ minimum: 0 }), taskIds: Type.Array(id, { maxItems: 32 }), domainIds: Type.Array(id, { maxItems: 16 }), goalIds: Type.Array(id, { maxItems: 16 }), knowledgeIds: Type.Array(id, { maxItems: 32 }), taskRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), domainRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), goalRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), summary: text, reason: text, benefits: text, risks: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const author = identityAny(directory, api.conversationId); const board = await tx.doc(TaskBoard); const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore); const knowledge = await tx.doc(KnowledgeStore); const state = await tx.doc(OrganizationStore); state.handoffs ??= [];
  const proposalId = `${kind}:${api.conversationId}:${api.callId}`; const old = state.handoffs.find(p => p.id === proposalId);
  if (old) { const { id: _id, author: _author, fromAgentId: _from, reviewer: _reviewer, status: _status, review: _review, createdAt: _created, updatedAt: _updated, handoffStatus: _handoffStatus, completedAt: _completedAt, kind: _kind, ...input } = old; if (JSON.stringify(input) !== JSON.stringify(a)) throw new Error("Proposal operation reused"); return proposalId; }
  const p: HandoffProposal = { id: proposalId, author: author.id, fromAgentId: author.id, reviewer: null, status: "proposed", ...a, review: "", createdAt: api.now(), updatedAt: api.now(), handoffStatus: "proposed", completedAt: null, kind };
  validateHandoff(directory, board, domains, goals, p); checkChangeBudget(state.run);
  if (p.knowledgeIds.some(id => !knowledge.entries.some(entry => entry.id === id && entry.status === "verified"))) throw new Error("Verified knowledge required");
  const reviewer = (["author", "source_reviewer", "gist_reviewer"] as Role[]).find(role => directory.ids[role] !== undefined && directory.ids[role] !== api.conversationId && directory.agents?.some(agent => agent.conversationId === String(directory.ids[role]) && agent.status === "active"));
  if (!reviewer) throw new Error("Independent reviewer unavailable");
  state.handoffs.push(p); addTask(board, newTask({ id: `review:${proposalId}`, type: "organization_review", description: proposalId, role: reviewer }, api.now())); return proposalId;
}, ctx)) }); }
const handoff = handoffTool("handoff");
const consolidate = handoffTool("consolidate");
const status = defineTool({ name: "organization_status", description: "Inspect an organization proposal", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const state = await api.snapshot(OrganizationStore, ctx); const p = state?.proposals.find(p => p.id === a.id) ?? state?.spawnProposals?.find(p => p.id === a.id) ?? state?.lifecycleProposals?.find(p => p.id === a.id) ?? state?.handoffs?.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing"); return output(p); } });
const review = defineTool({ name: "organization_review", description: "Independently review a delegation proposal", parameters: Type.Object({ id, decision: Type.Union([Type.Literal("start"), Type.Literal("approve"), Type.Literal("reject")]), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); const actor = identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const spawn = state.spawnProposals?.find(p => p.id === a.id); const lifecycle = state.lifecycleProposals?.find(p => p.id === a.id); const transfer = state.handoffs?.find(p => p.id === a.id); const p = spawn ?? lifecycle ?? transfer ?? state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (actor.id === p.author || (p.reviewer && p.reviewer !== actor.id)) throw new Error("Independent reviewer required");
  if (a.decision === "start" && p.status === "proposed") { p.reviewer = actor.id; p.status = "under_review"; }
  else if (a.decision !== "start" && p.status === "under_review") { if (a.decision === "approve") { if (spawn) { validateSpawn(directory, await tx.doc(TaskBoard), await tx.doc(DomainStore), await tx.doc(GoalStore), spawn); checkSpawnBudget(directory, state.run); } else if (lifecycle) { validateLifecycle(directory, await tx.doc(TaskBoard), await tx.doc(DomainStore), lifecycle, api.now(), state.handoffs, await tx.doc(GoalStore)); checkChangeBudget(state.run); if (lifecycle.kind === "reuse") checkCapacity(directory, state.run!); } else if (transfer) { validateHandoff(directory, await tx.doc(TaskBoard), await tx.doc(DomainStore), await tx.doc(GoalStore), transfer); checkChangeBudget(state.run); } else validate(directory, await tx.doc(TaskBoard), p as DelegationProposal); } p.status = a.decision === "approve" ? "approved" : "rejected"; p.review = a.reason; }
  else if ((a.decision === "start" && p.status === "under_review") || (a.decision === "approve" && (p.status === "approved" || p.status === "applied")) || (a.decision === "reject" && p.status === "rejected")) return p.status;
  else throw new Error("Invalid review transition");
  if (transfer && p.status === "rejected") { transfer.handoffStatus = "failed"; transfer.completedAt = api.now(); }
  p.updatedAt = api.now(); return p.status;
}, ctx)) });
const apply = defineTool({ name: "organization_apply", description: "Apply an independently approved delegation", parameters: Type.Object({ id }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); identity(directory, api.conversationId); const state = await tx.doc(OrganizationStore); const spawn = state.spawnProposals?.find(p => p.id === a.id); const lifecycle = state.lifecycleProposals?.find(p => p.id === a.id); const transfer = state.handoffs?.find(p => p.id === a.id); const p = spawn ?? lifecycle ?? transfer ?? state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (p.status === "applied") return p.status;
  if (p.status !== "approved" || !p.reviewer || p.reviewer === p.author) throw new Error("Independent approval required");
  const board = await tx.doc(TaskBoard);
  if (transfer) {
    const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore); const { from, to } = validateHandoff(directory, board, domains, goals, transfer); checkChangeBudget(state.run); const now = api.now();
    if (transfer.kind === "consolidate") {
      if (now < from.updatedAt + 60000) throw new OrganizationDeferred("Agent is in cooldown");
      const id = Number(from.conversationId); if (!Number.isSafeInteger(id) || id < 0 || String(id) !== from.conversationId) throw new Error("Invalid conversation ID");
      for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) if ((await tx.scanTasks({ conversationId: id as ConversationId, status }, 1)).items.length) throw new OrganizationDeferred("Agent has running durable work");
      if (state.handoffs?.some(p => p.id !== transfer.id && p.fromAgentId === from.id && ["proposed", "under_review", "approved"].includes(p.status))) throw new Error("Agent has an unfinished handoff");
    }
    for (const id of transfer.taskIds) { const task = board.tasks.find(t => t.id === id)!; task.assignedAgentId = to.id; touch(task, now); }
    for (const id of transfer.domainIds) { const domain = domains.domains.find(d => d.id === id)!; domain.stewardId = to.conversationId; domain.revision++; domain.updatedAt = now; }
    from.domainIds = from.domainIds.filter(id => !transfer.domainIds.includes(id)); to.domainIds = [...new Set([...to.domainIds, ...transfer.domainIds])];
    from.goalIds = from.goalIds.filter(id => !transfer.goalIds.includes(id)); to.goalIds = [...new Set([...to.goalIds, ...transfer.goalIds])];
    from.revision++; from.updatedAt = now; to.revision++; to.updatedAt = now;
    if (transfer.kind === "consolidate") { transitionAgent(from, from.revision, "draining", now); transitionAgent(from, from.revision, "dormant", now); }
    state.run!.roundChanges++; transfer.status = "applied"; transfer.handoffStatus = "committed"; transfer.completedAt = now; transfer.updatedAt = now; return transfer.status;
  }
  if (lifecycle) {
    const domains = await tx.doc(DomainStore); const goals = await tx.doc(GoalStore);
    const agent = validateLifecycle(directory, board, domains, lifecycle, api.now(), state.handoffs, goals); checkChangeBudget(state.run);
    const conversationNumber = Number(agent.conversationId); if (!Number.isSafeInteger(conversationNumber) || conversationNumber < 0 || String(conversationNumber) !== agent.conversationId || !(await tx.conversation(conversationNumber as ConversationId))) throw new OrganizationConflict("Agent conversation missing or invalid");
    if (lifecycle.kind === "reuse") checkCapacity(directory, state.run!);
    if (lifecycle.kind === "retire" || lifecycle.kind === "reassign") {
      const id = Number(agent.conversationId);
      if (!Number.isSafeInteger(id) || id < 0 || String(id) !== agent.conversationId) throw new Error("Invalid conversation ID");
      for (const status of ["pending", "running", "waiting", "sleeping", "completing"] as const) if ((await tx.scanTasks({ conversationId: id as ConversationId, status }, 1)).items.length) throw new OrganizationDeferred("Agent has running durable work");
    }
    if (lifecycle.kind === "retire") { transitionAgent(agent, agent.revision, "draining", api.now()); transitionAgent(agent, agent.revision, "dormant", api.now()); }
    else if (lifecycle.kind === "reuse") { transitionAgent(agent, agent.revision, "recovering", api.now()); transitionAgent(agent, agent.revision, "active", api.now()); }
    else {
      const global = goals.goals.find(goal => goal.id === goals.globalId)!;
      const summary = agent.domainIds.map(id => { const domain = domains.domains.find(d => d.id === id)!; return `${domain.name}: ${domain.description.slice(0, 300)}`; }).join("; ");
      const subgoals = agent.goalIds.map(id => goals.goals.find(g => g.id === id)!.description.slice(0, 300)).join("; ");
      await configure(tx, Number(agent.conversationId) as ConversationId, { instructions: `最上位目的: ${global.description}\n役割: ${lifecycle.newRole}\n領域: ${summary}\n下位目標: ${subgoals}\n共有記憶と知識を参照し、タスクを取得してから作業する。最上位目的を変更しない。` });
      agent.role = lifecycle.newRole!; agent.revision++; agent.updatedAt = api.now();
    }
    state.run!.roundChanges++; lifecycle.status = "applied"; lifecycle.updatedAt = api.now(); return lifecycle.status;
  }
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
export const OrganizationExtension = defineExtension({ name: "delm-organization", tools: [list, inspect, analyze, propose, spawnPropose, retire, reuse, reassign, handoff, consolidate, status, review, apply, spawn] });
