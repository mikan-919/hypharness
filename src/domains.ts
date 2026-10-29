import type { Context } from "@earendil-works/chord";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { AgentDirectory } from "./agents.ts";
import { KnowledgeStore } from "./knowledge.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";
import type { Role } from "./agents.ts";

export type Domain = { id: string; name: string; description: string; stewardId: string; status: "active" | "merged" | "split" | "archived"; goalIds: string[]; parentIds: string[]; successorIds: string[]; revision: number; createdAt: number; updatedAt: number };
export type Membership = { knowledgeId: string; primaryId: string; relatedIds: string[] };
export type Relation = { id: string; from: string; to: string; type: "related" | "depends_on" | "overlaps" | "complements" | "contradicts"; evidence: string; author: string; active: boolean; createdAt: number };
export type DomainDefinition = { id: string; name: string; description: string; stewardId: string };
export type DomainChange =
  | { kind: "split"; sources: string[]; domains: DomainDefinition[]; assignments: Membership[] }
  | { kind: "merge"; sources: string[]; domains: DomainDefinition[]; assignments: Membership[] }
  | { kind: "transfer"; sources: string[]; stewardId: string };
export type DomainProposal = { id: string; author: string; reviewer: string | null; status: "proposed" | "under_review" | "approved" | "rejected" | "applied"; reason: string; benefits: string; risks: string; change: DomainChange; revisions: Record<string, number>; createdAt: number; updatedAt: number; review: string };
export type DomainState = { domains: Domain[]; memberships: Membership[]; relations: Relation[]; proposals: DomainProposal[]; audit: { proposalId: string; actor: string; at: number; detail: string }[]; discoveries: { id: string; domainIds: string[]; evidence: string; hypothesis: string; query: string; matches: string[]; taskId: string; createdAt: number; outcome: "pending" | "productive" | "unproductive"; outcomeReason: string }[]; operations: Record<string, { fingerprint: string; result: Membership }> };
export const DomainStore = defineDoc<DomainState>({ kind: "delm.domains", version: 1, scope: "session", initial: () => ({ domains: [], memberships: [], relations: [], proposals: [], audit: [], discoveries: [], operations: {} }), checkpointWhen: () => false });
export const DEFAULT_DOMAIN = "domain:default";
export function activeDomain(state: DomainState, id: string) { const domain = state.domains.find(d => d.id === id && d.status === "active"); if (!domain) throw new Error(`Active domain not found: ${id}`); return domain; }
export function checkRelations(state: DomainState) {
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("Circular domain dependency");
    const next = new Set([...path, id]);
    for (const edge of state.relations.filter(r => r.active && r.type === "depends_on" && r.from === id)) visit(edge.to, next);
  };
  for (const domain of state.domains.filter(d => d.status === "active")) visit(domain.id, new Set());
}
export function assertMemberships(state: DomainState) {
  const seen = new Set<string>();
  for (const membership of state.memberships) {
    if (seen.has(membership.knowledgeId)) throw new Error("Duplicate knowledge membership");
    seen.add(membership.knowledgeId); activeDomain(state, membership.primaryId);
    if (membership.relatedIds.includes(membership.primaryId) || new Set(membership.relatedIds).size !== membership.relatedIds.length) throw new Error("Invalid related domains");
    for (const id of membership.relatedIds) activeDomain(state, id);
  }
}
export async function reconcileDomains(harness: Harness, context: Context, now = Date.now()) {
  await harness.commit(async tx => {
    const state = await tx.doc(DomainStore); const directory = await tx.doc(AgentDirectory); const knowledge = await tx.doc(KnowledgeStore);
    const author = directory.ids.author;
    if (author === undefined) return;
    if (!state.domains.some(d => d.id === DEFAULT_DOMAIN)) state.domains.push({ id: DEFAULT_DOMAIN, name: "未分類", description: "未分類の共有知識", stewardId: String(author), status: "active", goalIds: [], parentIds: [], successorIds: [], revision: 0, createdAt: now, updatedAt: now });
    for (const domain of state.domains.filter(d => d.status === "active")) if (!Object.values(directory.ids).some(id => String(id) === domain.stewardId)) throw new Error(`Domain steward is not registered: ${domain.id}`);
    let domain = state.domains.find(d => d.id === DEFAULT_DOMAIN);
    const visited = new Set<string>();
    while (domain && domain.status !== "active") {
      if (visited.has(domain.id)) throw new Error("Circular domain succession");
      visited.add(domain.id);
      domain = state.domains.find(d => d.id === domain!.successorIds[0]);
    }
    if (!domain) throw new Error("Default domain has no active successor");
    let added = false;
    for (const entry of knowledge.entries) if (!state.memberships.some(m => m.knowledgeId === entry.id)) { state.memberships.push({ knowledgeId: entry.id, primaryId: domain.id, relatedIds: [] }); added = true; }
    if (added) { domain.revision++; domain.updatedAt = now; }
    assertMemberships(state);
    const board = await tx.doc(TaskBoard);
    for (const discovery of state.discoveries.filter(d => d.outcome === "pending")) {
      const original = board.tasks.find(t => t.id === discovery.taskId);
      const role = Object.entries(directory.ids).find(([, value]) => String(value) === original?.owner)?.[0] as Role | undefined;
      const taskId = `discovery-feedback:${discovery.id}`;
      if (role && original && (original.state === "completed" || original.state === "failed") && !board.tasks.some(t => t.id === taskId)) addTask(board, newTask({ id: taskId, type: "discovery_feedback", description: discovery.id, role }, now));
    }
    for (const candidate of state.domains.filter(d => d.status === "active")) {
      const members = state.memberships.filter(m => m.primaryId === candidate.id || m.relatedIds.includes(candidate.id));
      const signals = members.filter(m => m.relatedIds.length > 0).length + state.relations.filter(r => r.active && (r.from === candidate.id || r.to === candidate.id)).length;
      const role = (Object.entries(directory.ids).find(([, value]) => String(value) === candidate.stewardId)?.[0]) as Role | undefined;
      const taskId = `domain-analysis:${candidate.id}:${candidate.revision}`;
      if (role && members.length >= 4 && signals >= 2 && !board.tasks.some(t => t.id === taskId) && board.tasks.filter(t => t.type === "domain_analysis").length < 20) addTask(board, newTask({ id: taskId, type: "domain_analysis", description: candidate.id, role }, now));
    }
  }, context);
}

export function applyDomainChange(state: DomainState, change: DomainChange, agents: number[], activeKnowledgeTasks: string[], now: number) {
  if (!change.sources.length || new Set(change.sources).size !== change.sources.length) throw new Error("Invalid sources");
  const sources = change.sources.map(id => activeDomain(state, id));
  const affected = state.memberships.filter(m => change.sources.includes(m.primaryId) || m.relatedIds.some(id => change.sources.includes(id)));
  if (change.kind !== "transfer" && affected.some(m => activeKnowledgeTasks.includes(m.knowledgeId))) throw new Error("Affected knowledge has claimed tasks");
  if (change.kind === "transfer") {
    if (sources.length !== 1 || !agents.some(id => String(id) === change.stewardId)) throw new Error("Invalid transfer");
    sources[0]!.stewardId = change.stewardId; sources[0]!.revision++; sources[0]!.updatedAt = now;
    return;
  }
  if (change.kind === "split" && (sources.length !== 1 || change.domains.length < 2 || change.domains.length > 8)) throw new Error("Invalid split");
  if (change.kind === "merge" && (sources.length < 2 || change.domains.length !== 1)) throw new Error("Invalid merge");
  const newIds = change.domains.map(d => d.id);
  if (new Set(newIds).size !== newIds.length || change.domains.some(d => !d.id || !d.name || !d.description || state.domains.some(old => old.id === d.id) || !agents.some(id => String(id) === d.stewardId))) throw new Error("Invalid new domain");
  const goalIds = [...new Set(sources.flatMap(d => d.goalIds))];
  for (const d of change.domains) state.domains.push({ ...d, status: "active", goalIds, parentIds: [...change.sources], successorIds: [], revision: 0, createdAt: now, updatedAt: now });
  if (change.kind === "split") {
    if (change.assignments.length !== affected.length || new Set(change.assignments.map(m => m.knowledgeId)).size !== affected.length) throw new Error("Assignments must cover each affected knowledge once");
    for (const old of affected) {
      const next = change.assignments.find(m => m.knowledgeId === old.knowledgeId);
      if (!next) throw new Error("Missing knowledge assignment");
      if (old.primaryId === sources[0]!.id ? !newIds.includes(next.primaryId) : next.primaryId !== old.primaryId) throw new Error("Invalid primary assignment");
      const retained = old.relatedIds.filter(id => !change.sources.includes(id));
      if (retained.some(id => !next.relatedIds.includes(id) && next.primaryId !== id)) throw new Error("Related domain lost");
      if (old.relatedIds.includes(sources[0]!.id) && !newIds.some(id => id === next.primaryId || next.relatedIds.includes(id))) throw new Error("Split reference lost");
      old.primaryId = next.primaryId; old.relatedIds = [...next.relatedIds];
    }
  } else {
    const target = newIds[0]!;
    for (const m of affected) {
      if (change.sources.includes(m.primaryId)) m.primaryId = target;
      m.relatedIds = [...new Set(m.relatedIds.map(id => change.sources.includes(id) ? target : id))].filter(id => id !== m.primaryId);
    }
  }
  for (const source of sources) { source.status = change.kind === "split" ? "split" : "merged"; source.successorIds = [...newIds]; source.revision++; source.updatedAt = now; }
  const edges = state.relations.filter(r => r.active && (change.sources.includes(r.from) || change.sources.includes(r.to)));
  for (const edge of edges) {
    edge.active = false;
    const froms = change.sources.includes(edge.from) ? newIds : [edge.from];
    const tos = change.sources.includes(edge.to) ? newIds : [edge.to];
    for (const from of froms) for (const to of tos) {
      if (from === to) continue;
      if (!state.relations.some(r => r.active && r.from === from && r.to === to && r.type === edge.type)) state.relations.push({ ...edge, id: `${edge.id}:${from}:${to}`, from, to, active: true, createdAt: now });
    }
  }
  assertMemberships(state); checkRelations(state);
}
