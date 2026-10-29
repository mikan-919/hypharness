import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { AgentDirectory, type Role } from "../agents.ts";
import { DomainStore } from "../domains.ts";
import { GoalStore, applyGoalChange, type GoalState } from "../goals.ts";
import { TaskBoard, addTask, newTask } from "../tasks.ts";

const id = Type.String({ minLength: 1, maxLength: 200 });
const text = Type.String({ minLength: 1, maxLength: 4000 });
const draft = Type.Object({ id, description: text, parentId: id, domainIds: Type.Array(id, { maxItems: 32 }), dependencies: Type.Array(id, { maxItems: 32 }) });
const output = (x: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(x) }] });
const goalList = defineTool({ name: "goal_list", description: "List bounded goal summaries", parameters: Type.Object({ offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }), execute: async (a, api, ctx) => { const state = await api.snapshot(GoalStore, ctx); const goals = state?.goals ?? []; const offset = a.offset ?? 0; return output({ globalId: state?.globalId ?? null, total: goals.length, goals: goals.slice(offset, offset + (a.limit ?? 20)).map(({ id, description, parentId, status, domainIds, revision }) => ({ id, description: description.slice(0, 500), parentId, status, domainIds: domainIds.slice(0, 10), revision })) }); } });
const inspect = defineTool({ name: "goal_inspect", description: "Inspect a goal", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const state = await api.snapshot(GoalStore, ctx); const goal = state?.goals.find(g => g.id === a.id); if (!goal) throw new Error("Goal missing"); return output(goal); } });
const proposalInspect = defineTool({ name: "goal_proposal_inspect", description: "Inspect a subgoal proposal before reviewing it", parameters: Type.Object({ id }), execute: async (a, api, ctx) => { const state = await api.snapshot(GoalStore, ctx); const proposal = state?.proposals.find(p => p.id === a.id); if (!proposal) throw new Error("Proposal missing"); return output(proposal); } });
const propose = defineTool({ name: "goal_propose", description: "Propose a subgoal change aligned with the immutable global goal", parameters: Type.Object({ kind: Type.Union([Type.Literal("create"), Type.Literal("update"), Type.Literal("cancel"), Type.Literal("complete"), Type.Literal("split"), Type.Literal("merge"), Type.Literal("reassign")]), sources: Type.Array(id, { maxItems: 8 }), goals: Type.Array(draft, { maxItems: 8 }), expectedRevisions: Type.Record(id, Type.Integer({ minimum: 0 })), reason: text, alignment: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); if (!Object.values(directory.ids).includes(api.conversationId)) throw new Error("Unregistered agent");
  const state = await tx.doc(GoalStore); const proposalId = `goal-proposal:${api.conversationId}:${api.callId}`;
  const change = { kind: a.kind, sources: a.sources, goals: a.goals };
  const old = state.proposals.find(p => p.id === proposalId);
  if (old) { if (JSON.stringify([old.change, old.reason, old.alignment, old.revisions]) !== JSON.stringify([change, a.reason, a.alignment, a.expectedRevisions])) throw new Error("Proposal operation reused"); return proposalId; }
  if (state.audit.length >= 50 || state.proposals.length >= 200) throw new Error("Goal change budget exhausted");
  for (const source of a.sources) { const goal = state.goals.find(g => g.id === source); if (!goal || goal.revision !== a.expectedRevisions[source]) throw new Error("Goal revision conflict"); }
  const domains = await tx.doc(DomainStore); const board = await tx.doc(TaskBoard);
  const copy: GoalState = JSON.parse(JSON.stringify(state)); applyGoalChange(copy, change, domains.domains.filter(d => d.status === "active").map(d => d.id), board.tasks.filter(t => t.state === "open" || t.state === "claimed").flatMap(t => t.goalId ? [t.goalId] : []), api.now());
  const reviewer = (["author", "source_reviewer", "gist_reviewer"] as Role[]).find(role => directory.ids[role] !== undefined && directory.ids[role] !== api.conversationId); if (!reviewer) throw new Error("Independent reviewer unavailable");
  state.proposals.push({ id: proposalId, author: String(api.conversationId), reviewer: null, status: "proposed", reason: a.reason, alignment: a.alignment, change, revisions: a.expectedRevisions, createdAt: api.now(), updatedAt: api.now(), review: "" });
  addTask(board, newTask({ id: `review:${proposalId}`, type: "goal_review", description: proposalId, role: reviewer }, api.now())); return proposalId;
}, ctx)) });
const review = defineTool({ name: "goal_review", description: "Independently review a subgoal proposal", parameters: Type.Object({ id, decision: Type.Union([Type.Literal("start"), Type.Literal("approve"), Type.Literal("reject")]), reason: text }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); if (!Object.values(directory.ids).includes(api.conversationId)) throw new Error("Unregistered agent"); const state = await tx.doc(GoalStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  const reviewer = String(api.conversationId); if (reviewer === p.author || (p.reviewer && p.reviewer !== reviewer)) throw new Error("Independent reviewer required");
  if (a.decision === "start" && p.status === "proposed") { p.reviewer = reviewer; p.status = "under_review"; }
  else if (a.decision !== "start" && p.status === "under_review") {
    if (a.decision === "approve") {
      for (const source of p.change.sources) { const goal = state.goals.find(g => g.id === source); if (!goal || goal.revision !== p.revisions[source]) throw new Error("Goal revision conflict"); }
      const domains = await tx.doc(DomainStore); const board = await tx.doc(TaskBoard); const copy: GoalState = JSON.parse(JSON.stringify(state));
      applyGoalChange(copy, p.change, domains.domains.filter(d => d.status === "active").map(d => d.id), board.tasks.filter(t => t.state === "open" || t.state === "claimed").flatMap(t => t.goalId ? [t.goalId] : []), api.now());
    }
    p.status = a.decision === "approve" ? "approved" : "rejected"; p.review = a.reason;
  }
  else if ((a.decision === "start" && p.status === "under_review") || (a.decision === "approve" && (p.status === "approved" || p.status === "applied")) || (a.decision === "reject" && p.status === "rejected")) return p.status;
  else throw new Error("Invalid review transition"); p.updatedAt = api.now(); return p.status;
}, ctx)) });
const apply = defineTool({ name: "goal_apply", description: "Apply an approved subgoal proposal atomically", parameters: Type.Object({ id }), replay: "safe", execute: async (a, api, ctx) => output(await api.commit(async tx => {
  const directory = await tx.doc(AgentDirectory); if (!Object.values(directory.ids).includes(api.conversationId)) throw new Error("Unregistered agent"); const state = await tx.doc(GoalStore); const p = state.proposals.find(p => p.id === a.id); if (!p) throw new Error("Proposal missing");
  if (p.status === "applied") return p.status; if (p.status !== "approved" || !p.reviewer || p.reviewer === p.author) throw new Error("Independent approval required");
  for (const source of p.change.sources) { const goal = state.goals.find(g => g.id === source); if (!goal || goal.revision !== p.revisions[source]) throw new Error("Goal revision conflict"); }
  const domains = await tx.doc(DomainStore); const board = await tx.doc(TaskBoard); applyGoalChange(state, p.change, domains.domains.filter(d => d.status === "active").map(d => d.id), board.tasks.filter(t => t.state === "open" || t.state === "claimed").flatMap(t => t.goalId ? [t.goalId] : []), api.now());
  for (const draft of p.change.goals) {
    const goal = state.goals.find(g => g.id === draft.id && g.status === "active"); if (!goal) continue;
    const domain = domains.domains.find(d => d.id === goal.domainIds[0] && d.status === "active");
    const role = (Object.entries(directory.ids).find(([, value]) => String(value) === domain?.stewardId)?.[0] ?? "author") as Role;
    const taskId = `goal:work:${goal.id}:${goal.revision}`;
    if (!board.tasks.some(t => t.id === taskId)) addTask(board, newTask({ id: taskId, type: "subgoal", description: goal.description, role, goalId: goal.id }, api.now()));
  }
  for (const domain of domains.domains.filter(d => d.status === "active")) { const selected = [...(state.globalId && domain.goalIds.includes(state.globalId) ? [state.globalId] : []), ...state.goals.filter(g => g.id !== state.globalId && g.status === "active" && g.domainIds.includes(domain.id)).map(g => g.id)]; if (JSON.stringify(selected) !== JSON.stringify(domain.goalIds)) { domain.goalIds = selected; domain.revision++; domain.updatedAt = api.now(); } }
  p.status = "applied"; p.updatedAt = api.now(); state.audit.push({ proposalId: p.id, actor: String(api.conversationId), at: api.now() }); return p.status;
}, ctx)) });
export const GoalExtension = defineExtension({ name: "delm-goals", tools: [goalList, inspect, proposalInspect, propose, review, apply] });
