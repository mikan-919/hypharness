import { Type } from "@earendil-works/pi-ai";
import { createHash } from "node:crypto";
import { defineExtension, defineTool, type ToolExecutionApi } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { AgentDirectory, type AgentRecord, type Role } from "../agents.ts";
import { DomainStore, activeDomain, applyDomainChange, assertMemberships, checkRelations, type DomainChange, type DomainState } from "../domains.ts";
import { GoalStore, type GoalState } from "../goals.ts";
import { KnowledgeStore } from "../knowledge.ts";
import { TaskBoard, addTask, newTask, type Board } from "../tasks.ts";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const def = Type.Object({ id, name: text, description: text, stewardId: id });
const membership = Type.Object({ knowledgeId: id, primaryId: id, relatedIds: Type.Array(id, { maxItems: 32 }) });
const relationType = Type.Union([Type.Literal("related"), Type.Literal("depends_on"), Type.Literal("overlaps"), Type.Literal("complements"), Type.Literal("contradicts")]);
const output = (x: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(x) }] });
function identity(ids: Partial<Record<Role, number>>, conversation: number): Role { const pair = Object.entries(ids).find(([, value]) => value === conversation); if (!pair) throw new Error("Unregistered agent"); return pair[0] as Role; }
type Directory = { ids: Partial<Record<Role, number>>; agents?: AgentRecord[] };
function domainActor(directory: Directory, conversation: number) { if (Object.values(directory.ids).includes(conversation)) return; if (!directory.agents?.some(a => a.conversationId === String(conversation) && a.status === "active" && a.capabilities.includes("domain_management"))) throw new Error("Domain management capability required"); }
function stewardIds(directory: Directory): number[] { const ids = new Set(Object.values(directory.ids)); for (const agent of directory.agents ?? []) { if (agent.status !== "active" || !agent.capabilities.includes("domain_management")) continue; const id = Number(agent.conversationId); if (!Number.isSafeInteger(id) || id < 0 || String(id) !== agent.conversationId) throw new Error("Invalid conversation ID"); ids.add(id); } return [...ids]; }
function reviewRole(ids: Partial<Record<Role, number>>, author: number): Role { const role = (["author", "source_reviewer", "gist_reviewer"] as const).find(r => ids[r] !== undefined && ids[r] !== author); if (!role) throw new Error("Independent reviewer unavailable"); return role; }
function checkGoalClaims(change: DomainChange, goals: GoalState, board: Board) {
  if (change.kind === "transfer") return;
  if (board.tasks.some(t => t.state === "claimed" && t.goalId && goals.goals.some(g => g.id === t.goalId && g.domainIds.some(id => change.sources.includes(id))))) throw new Error("Affected goal has claimed tasks");
}
const list = defineTool({ name: "domain_list", description: "List concise active domain summaries", parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), execute: async (args, api, ctx) => { const domains = (await api.snapshot(DomainStore, ctx))?.domains.filter(d => d.status === "active") ?? []; const offset = args.offset ?? 0; return output({ total: domains.length, domains: domains.slice(offset, offset + (args.limit ?? 20)).map(({ id, name, description, stewardId, goalIds, revision }) => ({ id, name: name.slice(0, 100), description: description.slice(0, 300), stewardId, goalIds: goalIds.slice(0, 10), revision })) }); } });
const inspect = defineTool({ name: "domain_inspect", description: "Inspect domain metadata and a bounded page of knowledge IDs", parameters: Type.Object({ id, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), execute: async (args, api, ctx) => { const state = await api.snapshot(DomainStore, ctx); const domain = state?.domains.find(d => d.id === args.id); if (!domain) throw new Error("Domain not found"); const memberships = state!.memberships.filter(m => m.primaryId === args.id || m.relatedIds.includes(args.id)); const offset = args.offset ?? 0; return output({ domain, membershipCount: memberships.length, memberships: memberships.slice(offset, offset + (args.limit ?? 20)), relations: state!.relations.filter(r => r.active && (r.from === args.id || r.to === args.id)).slice(0, 20) }); } });
const create = defineTool({ name: "domain_create", description: "Create an empty domain", parameters: Type.Object({ ...def.properties, goalIds: Type.Array(id, { maxItems: 32 }) }), replay: "safe", execute: async (args, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); identity(directory.ids, api.conversationId);
  if (!stewardIds(directory).some(x => String(x) === args.stewardId)) throw new Error("Unknown steward");
  const state = await tx.doc(DomainStore); const existing = state.domains.find(d => d.id === args.id);
  if (existing) { if (existing.name === args.name && existing.description === args.description && existing.stewardId === args.stewardId && JSON.stringify(existing.goalIds) === JSON.stringify(args.goalIds)) return existing.id; throw new Error("Domain ID already used"); }
  const goals = await tx.doc(GoalStore); for (const goal of args.goalIds) if (!goals.goals.some(g => g.id === goal && g.status === "active")) throw new Error("Unknown goal");
  const now = api.now(); state.domains.push({ ...args, status: "active", parentIds: [], successorIds: [], revision: 0, createdAt: now, updatedAt: now });
  for (const goal of goals.goals.filter(g => g.id !== goals.globalId && args.goalIds.includes(g.id))) { if (!goal.domainIds.includes(args.id)) goal.domainIds.push(args.id); goal.revision++; goal.updatedAt = now; }
  return args.id;
}, ctx)) });
const assign = defineTool({ name: "domain_assign", description: "Assign a knowledge reference, retaining one primary domain", parameters: Type.Object({ ...membership.properties, expectedRevision: Type.Integer({ minimum: 0 }) }), replay: "safe", execute: async (args, api, ctx) => output(await api.commit(async tx => {
  const state = await tx.doc(DomainStore); const directory = await tx.doc(AgentDirectory); domainActor(directory, api.conversationId); const domain = activeDomain(state, args.primaryId);
  const operationId = `assign:${api.conversationId}:${api.callId}`, fingerprint = JSON.stringify(args), prior = state.operations[operationId];
  if (prior) { if (prior.fingerprint !== fingerprint) throw new Error("Assignment operation reused"); return { knowledgeId: prior.result.knowledgeId, primaryId: prior.result.primaryId, relatedIds: [...prior.result.relatedIds] }; }
  if (domain.stewardId !== String(api.conversationId)) throw new Error("Only primary steward may assign knowledge");
  const knowledge = await tx.doc(KnowledgeStore); if (!knowledge.entries.some(k => k.id === args.knowledgeId)) throw new Error("Knowledge not found");
  const existing = state.memberships.find(m => m.knowledgeId === args.knowledgeId);
  if (existing && existing.primaryId !== args.primaryId && activeDomain(state, existing.primaryId).stewardId !== String(api.conversationId)) throw new Error("Current steward must authorize reassignment");
  const next = { knowledgeId: args.knowledgeId, primaryId: args.primaryId, relatedIds: args.relatedIds };
  if (domain.revision !== args.expectedRevision) throw new Error("Domain revision conflict");
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) { state.operations[operationId] = { fingerprint, result: next }; return next; }
  const changedDomains = new Set([domain.id, ...args.relatedIds, ...(existing ? [existing.primaryId, ...existing.relatedIds] : [])]);
  if (existing) Object.assign(existing, next); else state.memberships.push(next);
  assertMemberships(state); for (const id of changedDomains) { const changed = activeDomain(state, id); changed.revision++; changed.updatedAt = api.now(); } state.operations[operationId] = { fingerprint, result: next }; return next;
}, ctx)) });
async function propose(change: DomainChange, args: { reason: string; benefits: string; risks: string; expectedRevisions: Record<string, number> }, api: ToolExecutionApi, ctx: Context) {
  return api.commit(async tx => {
    const state = await tx.doc(DomainStore); const directory = await tx.doc(AgentDirectory); domainActor(directory, api.conversationId);
    const proposalId = `domain-proposal:${api.conversationId}:${api.callId}`;
    const previous = state.proposals.find(p => p.id === proposalId);
    if (previous) { if (JSON.stringify([previous.change, previous.reason, previous.benefits, previous.risks, previous.revisions]) !== JSON.stringify([change, args.reason, args.benefits, args.risks, args.expectedRevisions])) throw new Error("Proposal operation reused"); return proposalId; }
    if (state.audit.length >= 50) throw new Error("Reorganization budget exhausted");
    if (state.proposals.some(p => (p.status === "proposed" || p.status === "under_review") && p.change.sources.some(s => change.sources.includes(s)))) throw new Error("A domain review is already pending");
    const sourceDomains = change.sources.map(source => activeDomain(state, source));
    if (!sourceDomains.some(domain => domain.stewardId === String(api.conversationId))) throw new Error("Only a domain steward may propose");
    for (const domain of sourceDomains) if (domain.revision !== args.expectedRevisions[domain.id]) throw new Error("Domain revision conflict");
    if (state.audit.some(a => api.now() - a.at < 60000 && state.proposals.find(p => p.id === a.proposalId)?.change.sources.some(s => change.sources.includes(s)))) throw new Error("Domain reorganization cooldown");
    const board = await tx.doc(TaskBoard); const goals = await tx.doc(GoalStore); checkGoalClaims(change, goals, board); const claimed = board.tasks.filter(t => t.state === "claimed" && t.knowledgeId).map(t => t.knowledgeId!);
    const copy: DomainState = JSON.parse(JSON.stringify(state)); applyDomainChange(copy, change, stewardIds(directory), claimed, api.now());
    state.proposals.push({ id: proposalId, author: String(api.conversationId), reviewer: null, status: "proposed", ...args, change, revisions: args.expectedRevisions, createdAt: api.now(), updatedAt: api.now(), review: "" });
    addTask(board, newTask({ id: `review:${proposalId}`, type: "domain_review", description: proposalId, role: reviewRole(directory.ids, api.conversationId) }, api.now()));
    return proposalId;
  }, ctx);
}
const reasons = { reason: text, benefits: text, risks: text, expectedRevisions: Type.Record(id, Type.Integer({ minimum: 0 })) };
const split = defineTool({ name: "domain_split", description: "Propose a split with complete knowledge assignments", parameters: Type.Object({ source: id, domains: Type.Array(def, { minItems: 2, maxItems: 8 }), assignments: Type.Array(membership), ...reasons }), replay: "safe", execute: async (a, api, ctx) => output(await propose({ kind: "split", sources: [a.source], domains: a.domains, assignments: a.assignments }, a, api, ctx)) });
const merge = defineTool({ name: "domain_merge", description: "Propose merging domains", parameters: Type.Object({ sources: Type.Array(id, { minItems: 2, maxItems: 8 }), domain: def, ...reasons }), replay: "safe", execute: async (a, api, ctx) => output(await propose({ kind: "merge", sources: a.sources, domains: [a.domain], assignments: [] }, a, api, ctx)) });
const transfer = defineTool({ name: "domain_transfer", description: "Propose transferring stewardship without changing any context", parameters: Type.Object({ source: id, stewardId: id, ...reasons }), replay: "safe", execute: async (a, api, ctx) => output(await propose({ kind: "transfer", sources: [a.source], stewardId: a.stewardId }, a, api, ctx)) });
const link = defineTool({ name: "domain_link", description: "Link domains with evidence", parameters: Type.Object({ from: id, to: id, type: relationType, evidence: text, expectedRevision: Type.Integer({ minimum: 0 }) }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); domainActor(directory, api.conversationId); const state = await tx.doc(DomainStore);
  const source = activeDomain(state, a.from); activeDomain(state, a.to); if (a.from === a.to || source.stewardId !== String(api.conversationId)) throw new Error("Invalid relation owner or target");
  const relId = `relation:${api.conversationId}:${api.callId}`; const previous = state.relations.find(r => r.id === relId);
  if (previous) { if (previous.from !== a.from || previous.to !== a.to || previous.type !== a.type || previous.evidence !== a.evidence) throw new Error("Relation operation reused"); return { ...previous }; }
  if (source.revision !== a.expectedRevision) throw new Error("Domain revision conflict");
  const relation = { id: relId, from: a.from, to: a.to, type: a.type, evidence: a.evidence, author: String(api.conversationId), active: true, createdAt: api.now() };
  state.relations.push(relation); checkRelations(state); source.revision++; source.updatedAt = api.now(); return relation;
}, ctx)) });
const proposals = defineTool({ name: "domain_proposal_list", description: "List proposal summaries, or inspect one proposal by ID", parameters: Type.Object({ id: Type.Optional(id) }), execute: async (a, api, ctx) => { const proposals = (await api.snapshot(DomainStore, ctx))?.proposals ?? []; if (a.id) { const proposal = proposals.find(p => p.id === a.id); if (!proposal) throw new Error("Proposal missing"); return output(proposal); } return output(proposals.map(({ id, author, reviewer, status, reason, change }) => ({ id, author, reviewer, status, reason, kind: change.kind, sources: change.sources }))); } });
const review = defineTool({ name: "domain_review", description: "Independently review a domain proposal; use start then approve or reject", parameters: Type.Object({ id, decision: Type.Union([Type.Literal("start"), Type.Literal("approve"), Type.Literal("reject")]), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const dir = await tx.doc(AgentDirectory); identity(dir.ids, api.conversationId); const state = await tx.doc(DomainStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  const reviewer = String(api.conversationId); if (p.author === reviewer || (p.reviewer !== null && p.reviewer !== reviewer)) throw new Error("Independent reviewer required");
  if (a.decision === "start" && p.status === "proposed") { p.status = "under_review"; p.reviewer = reviewer; }
  else if (a.decision !== "start" && p.status === "under_review") {
    if (a.decision === "approve") {
      for (const source of p.change.sources) if (activeDomain(state, source).revision !== p.revisions[source]) throw new Error("Domain revision conflict");
      const board = await tx.doc(TaskBoard); const goals = await tx.doc(GoalStore); checkGoalClaims(p.change, goals, board); const claimed = board.tasks.filter(t => t.state === "claimed" && t.knowledgeId).map(t => t.knowledgeId!);
      const copy: DomainState = JSON.parse(JSON.stringify(state)); applyDomainChange(copy, p.change, stewardIds(dir), claimed, api.now());
    }
    p.status = a.decision === "approve" ? "approved" : "rejected"; p.review = a.reason;
  }
  else if ((a.decision === "start" && p.status === "under_review") || (a.decision === "approve" && (p.status === "approved" || p.status === "applied")) || (a.decision === "reject" && p.status === "rejected")) return p.status;
  else throw new Error("Invalid review transition");
  p.updatedAt = api.now(); return p.status;
}, ctx)) });
const apply = defineTool({ name: "domain_apply", description: "Atomically apply an independently approved proposal", parameters: Type.Object({ id }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const dir = await tx.doc(AgentDirectory); identity(dir.ids, api.conversationId); const state = await tx.doc(DomainStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (p.status === "applied") return "applied"; if (p.status !== "approved" || p.author === p.reviewer || !p.reviewer) throw new Error("Proposal not independently approved");
  for (const source of p.change.sources) if (activeDomain(state, source).revision !== p.revisions[source]) throw new Error("Domain revision conflict");
  const board = await tx.doc(TaskBoard); const goals = await tx.doc(GoalStore); checkGoalClaims(p.change, goals, board); const claimed = board.tasks.filter(t => t.state === "claimed" && t.knowledgeId).map(t => t.knowledgeId!);
  applyDomainChange(state, p.change, stewardIds(dir), claimed, api.now());
  if (p.change.kind !== "transfer") { const targets = p.change.domains.map(d => d.id); for (const goal of goals.goals) { if (goal.id === goals.globalId || !goal.domainIds.some(d => p.change.sources.includes(d))) continue; goal.domainIds = [...new Set(goal.domainIds.flatMap(d => p.change.sources.includes(d) ? targets : [d]))]; goal.revision++; goal.updatedAt = api.now(); } }
  p.status = "applied"; p.updatedAt = api.now(); state.audit.push({ proposalId: p.id, actor: String(api.conversationId), at: api.now(), detail: p.change.kind }); return p.status;
}, ctx)) });
const analyze = defineTool({ name: "domain_analyze", description: "Analyze domain evidence and reorganization costs; retain status when evidence is insufficient", parameters: Type.Object({ id }), execute: async (a, api, ctx) => {
  const state = await api.snapshot(DomainStore, ctx); if (!state) throw new Error("Domain store missing"); const domain = activeDomain(state, a.id);
  const members = state.memberships.filter(m => m.primaryId === domain.id || m.relatedIds.includes(domain.id));
  const related = state.relations.filter(r => r.active && (r.from === domain.id || r.to === domain.id));
  const overlap = members.filter(m => m.relatedIds.length > 0).length;
  const board = await api.snapshot(TaskBoard, ctx); const claimed = (board?.tasks ?? []).filter(t => t.state === "claimed" && t.knowledgeId && members.some(m => m.knowledgeId === t.knowledgeId)).length;
  const stalled = (board?.tasks ?? []).filter(t => t.state === "failed" && t.knowledgeId && members.some(m => m.knowledgeId === t.knowledgeId)).length;
  const goals = await api.snapshot(GoalStore, ctx); const openGoals = (goals?.goals ?? []).filter(g => g.status === "active" && g.domainIds.includes(domain.id)).length;
  const sameSteward = state.domains.filter(d => d.status === "active" && d.stewardId === domain.stewardId).length;
  const contradictions = related.filter(r => r.type === "contradicts").length;
  const suggestion = contradictions && overlap ? "investigate_contradictions" : overlap >= 3 && related.length > 0 ? "consider_link_or_merge" : members.length >= 8 && claimed >= 3 ? "consider_split_or_transfer" : "keep";
  return output({ domainId: domain.id, revision: domain.revision, knowledgeCount: members.length, overlapCount: overlap, relationCount: related.length, contradictionCount: contradictions, claimedTasks: claimed, stalledTasks: stalled, openGoals, domainsWithSameSteward: sameSteward, suggestion, evidence: related.slice(0, 10).map(r => ({ id: r.id, evidence: r.evidence })), costs: "coordination, task continuity, context changes, and cache invalidation" });
} });
const discover = defineTool({ name: "domain_discover", description: "Explore linked domains and record an evidence-backed hypothesis and task; it is not verified knowledge", parameters: Type.Object({ domainIds: Type.Array(id, { minItems: 2, maxItems: 4 }), evidence: text, hypothesis: text, query: Type.Optional(text) }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const dir = await tx.doc(AgentDirectory); domainActor(dir, api.conversationId); const state = await tx.doc(DomainStore);
  const ids = [...new Set(a.domainIds)].sort(); if (ids.length !== a.domainIds.length) throw new Error("Duplicate domains"); for (const domain of ids) activeDomain(state, domain);
  const discoveryId = `discovery:${createHash("sha256").update(JSON.stringify(ids)).digest("hex")}`; const old = state.discoveries.find(d => d.id === discoveryId);
  if (old) { if (old.evidence !== a.evidence || old.hypothesis !== a.hypothesis || old.query !== (a.query ?? "")) throw new Error("Combination already explored"); return { ...old, domainIds: [...old.domainIds], matches: [...old.matches] }; }
  if (state.discoveries.length >= 20) throw new Error("Discovery budget exhausted");
  if (state.discoveries.filter(d => d.outcome === "pending").length >= 3 || state.discoveries.filter(d => d.outcome !== "pending").slice(-3).filter(d => d.outcome === "unproductive").length >= 3) throw new Error("Discovery paused pending evidence of usefulness");
  const connected = ids.every((domain, index) => index === 0 || ids.slice(0, index).some(other => state.relations.some(r => r.active && ((r.from === domain && r.to === other) || (r.from === other && r.to === domain))) || state.memberships.some(m => [m.primaryId, ...m.relatedIds].includes(domain) && [m.primaryId, ...m.relatedIds].includes(other))));
  if (!connected) throw new Error("Domain combination lacks supporting relations");
  const knowledge = await tx.doc(KnowledgeStore);
  const references = state.memberships.filter(m => ids.some(domain => m.primaryId === domain || m.relatedIds.includes(domain))).map(m => m.knowledgeId);
  const matches = knowledge.entries.filter(k => k.status === "verified" && references.includes(k.id) && (!a.query || k.gist.toLowerCase().includes(a.query.toLowerCase()))).slice(0, 10).map(k => k.id);
  const board = await tx.doc(TaskBoard); const taskId = `hypothesis:${api.conversationId}:${api.callId}`;
  addTask(board, newTask({ id: taskId, type: "hypothesis", description: `Discovery ID: ${discoveryId}\nUnverified hypothesis: ${a.hypothesis}\nEvidence: ${a.evidence}`, role: "author" }, api.now()));
  const record = { id: discoveryId, domainIds: ids, evidence: a.evidence, hypothesis: a.hypothesis, query: a.query ?? "", matches, taskId, createdAt: api.now(), outcome: "pending" as const, outcomeReason: "" }; state.discoveries.push(record); return record;
}, ctx)) });
const feedback = defineTool({ name: "domain_discovery_feedback", description: "Record whether a completed hypothesis task produced useful evidence", parameters: Type.Object({ id, productive: Type.Boolean(), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const dir = await tx.doc(AgentDirectory); domainActor(dir, api.conversationId); const state = await tx.doc(DomainStore); const discovery = state.discoveries.find(d => d.id === a.id); if (!discovery) throw new Error("Discovery missing");
  const board = await tx.doc(TaskBoard); const task = board.tasks.find(t => t.id === discovery.taskId); if (!task || task.owner !== String(api.conversationId) || (task.state !== "completed" && task.state !== "failed")) throw new Error("Only the completed task owner may report an outcome");
  const outcome = a.productive ? "productive" : "unproductive"; if (discovery.outcome !== "pending") { if (discovery.outcome !== outcome || discovery.outcomeReason !== a.reason) throw new Error("Discovery outcome already recorded"); return outcome; }
  discovery.outcome = outcome; discovery.outcomeReason = a.reason; return outcome;
}, ctx)) });
const discoveryInspect = defineTool({ name: "domain_discovery_inspect", description: "Inspect one recorded hypothesis and its task", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const state = await api.snapshot(DomainStore, ctx); const discovery = state?.discoveries.find(d => d.id === a.id); if (!discovery) throw new Error("Discovery missing"); const board = await api.snapshot(TaskBoard, ctx); const task = board?.tasks.find(t => t.id === discovery.taskId); return output({ discovery, task }); } });
export const DomainExtension = defineExtension({ name: "delm-domains", tools: [list, inspect, create, assign, split, merge, transfer, link, proposals, review, apply, analyze, discover, discoveryInspect, feedback] });
