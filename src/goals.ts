import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export type Goal = { id: string; description: string; parentId: string | null; status: "active" | "completed" | "superseded" | "cancelled"; domainIds: string[]; dependencies: string[]; revision: number; createdAt: number; updatedAt: number };
export type GoalChange = { kind: "create" | "update" | "cancel" | "complete" | "split" | "merge" | "reassign"; sources: string[]; goals: GoalDraft[] };
export type GoalDraft = { id: string; description: string; parentId: string; domainIds: string[]; dependencies: string[] };
export type GoalProposal = { id: string; author: string; reviewer: string | null; status: "proposed" | "under_review" | "approved" | "rejected" | "applied"; reason: string; alignment: string; change: GoalChange; revisions: Record<string, number>; createdAt: number; updatedAt: number; review: string };
export type GoalState = { globalId: string | null; goals: Goal[]; proposals: GoalProposal[]; audit: { proposalId: string; actor: string; at: number }[] };
export const GoalStore = defineDoc<GoalState>({ kind: "delm.goals", version: 1, scope: "session", initial: () => ({ globalId: null, goals: [], proposals: [], audit: [] }), checkpointWhen: () => false });
export async function initializeGlobalGoal(harness: Harness, description: string, context: Context, now = Date.now()) {
  const value = description.trim(); if (!value) throw new Error("Global goal must not be empty");
  await harness.commit(async tx => { const state = await tx.doc(GoalStore); const current = state.goals.find(g => g.id === state.globalId); if (current) { if (current.description !== value) throw new Error("Global goal is immutable"); return; } if (state.globalId !== null) throw new Error("Global goal missing"); state.globalId = "goal:global"; state.goals.push({ id: state.globalId, description: value, parentId: null, status: "active", domainIds: [], dependencies: [], revision: 0, createdAt: now, updatedAt: now }); }, context);
}
export function checkGoals(state: GoalState) {
  const global = state.goals.find(g => g.id === state.globalId && g.parentId === null && g.status === "active"); if (!global) throw new Error("Global goal missing");
  const visit = (id: string, path: Set<string>) => { if (path.has(id)) throw new Error("Circular goal hierarchy or dependency"); const goal = state.goals.find(g => g.id === id); if (!goal) throw new Error("Goal not found"); const next = new Set([...path, id]); if (goal.parentId) visit(goal.parentId, next); for (const dependency of goal.dependencies) visit(dependency, next); };
  for (const goal of state.goals) { visit(goal.id, new Set()); if (goal.id !== global.id && !goal.parentId) throw new Error("Subgoal must have parent"); }
}

export function applyGoalChange(state: GoalState, change: GoalChange, activeDomains: string[], activeTaskGoals: string[], now: number) {
  if (!state.globalId) throw new Error("Global goal required");
  if (new Set(change.sources).size !== change.sources.length) throw new Error("Duplicate goal sources");
  if (change.sources.includes(state.globalId) || change.goals.some(g => g.id === state.globalId)) throw new Error("Global goal is immutable");
  const sources = change.sources.map(id => { const goal = state.goals.find(g => g.id === id && g.status === "active"); if (!goal) throw new Error("Active goal not found"); return goal; });
  const drafts = change.goals;
  if (change.kind === "create" && (sources.length !== 0 || drafts.length !== 1)) throw new Error("Invalid creation");
  if (["update", "reassign"].includes(change.kind) && (sources.length !== 1 || drafts.length !== 1 || drafts[0]!.id !== sources[0]!.id)) throw new Error("Invalid update");
  if (change.kind === "cancel" && (sources.length !== 1 || drafts.length !== 0)) throw new Error("Invalid cancellation");
  if (change.kind === "complete" && (sources.length !== 1 || drafts.length !== 0)) throw new Error("Invalid completion");
  if (change.kind === "split" && (sources.length !== 1 || drafts.length < 2 || drafts.length > 8)) throw new Error("Invalid split");
  if (change.kind === "merge" && (sources.length < 2 || drafts.length !== 1)) throw new Error("Invalid merge");
  if (new Set(drafts.map(g => g.id)).size !== drafts.length) throw new Error("Duplicate goal IDs");
  for (const draft of drafts) {
    const existing = state.goals.find(g => g.id === draft.id);
    if (!draft.id || !draft.description || !draft.parentId || (existing && !(["update", "reassign"].includes(change.kind) && existing.id === sources[0]?.id))) throw new Error("Goal ID already used or invalid");
    if (!state.goals.some(g => g.id === draft.parentId && g.status === "active") || draft.domainIds.some(id => !activeDomains.includes(id))) throw new Error("Invalid goal parent or domain");
    for (const id of draft.dependencies) { const dependency = state.goals.find(g => g.id === id); if (dependency ? dependency.status === "cancelled" || dependency.status === "superseded" : !drafts.some(g => g.id === id)) throw new Error("Invalid goal dependency"); }
  }
  if (change.kind === "split" || change.kind === "merge") {
    const parents = new Set(sources.map(g => g.parentId));
    const dependencies = [...new Set(sources.flatMap(g => g.dependencies).filter(id => !change.sources.includes(id)))];
    if (parents.size !== 1 || drafts.some(g => g.parentId !== sources[0]?.parentId || dependencies.some(id => !g.dependencies.includes(id)))) throw new Error("Goal replacement must preserve parent and dependencies");
  }
  if ((change.kind === "update" || change.kind === "reassign") && sources.some(g => activeTaskGoals.includes(g.id))) throw new Error("Goal has active tasks");
  if (change.kind === "complete") { if (activeTaskGoals.includes(sources[0]!.id) || state.goals.some(g => g.parentId === sources[0]!.id && g.status === "active")) throw new Error("Goal has active tasks or subgoals"); sources[0]!.status = "completed"; sources[0]!.revision++; sources[0]!.updatedAt = now; }
  if (["cancel", "split", "merge"].includes(change.kind)) {
    if (sources.some(g => activeTaskGoals.includes(g.id))) throw new Error("Goal has active tasks");
    if (state.goals.some(g => g.status === "active" && !change.sources.includes(g.id) && ((g.parentId && change.sources.includes(g.parentId)) || g.dependencies.some(d => change.sources.includes(d))))) throw new Error("Goal has active dependents");
    for (const source of sources) { source.status = change.kind === "cancel" ? "cancelled" : "superseded"; source.revision++; source.updatedAt = now; }
  }
  if (change.kind === "update" || change.kind === "reassign") {
    const goal = sources[0]!, draft = drafts[0]!;
    if (change.kind === "reassign" && (goal.description !== draft.description || goal.parentId !== draft.parentId || JSON.stringify(goal.dependencies) !== JSON.stringify(draft.dependencies))) throw new Error("Reassignment may only change domains");
    Object.assign(goal, draft); goal.revision++; goal.updatedAt = now;
  } else for (const draft of drafts) state.goals.push({ ...draft, status: "active", revision: 0, createdAt: now, updatedAt: now });
  checkGoals(state);
}
