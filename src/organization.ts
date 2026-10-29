import { defineDoc } from "@earendil-works/pi-durable";

export type DelegationProposal = {
  id: string; author: string; reviewer: string | null; taskId: string; taskRevision: number;
  targetAgentId: string; targetRevision: number; reason: string; benefits: string; risks: string;
  status: "proposed" | "under_review" | "approved" | "rejected" | "applied";
  review: string; createdAt: number; updatedAt: number;
};
export type SpawnProposal = {
  id: string; author: string; reviewer: string | null; status: "proposed" | "under_review" | "approved" | "rejected" | "applied";
  name: string; role: string; capabilities: string[]; initialGoalIds: string[]; initialDomainIds: string[];
  taskId: string; taskRevision: number; domainRevisions: Record<string, number>; goalRevisions: Record<string, number>;
  reason: string; reuseReason: string; benefits: string; costs: string; risks: string; review: string;
  createdAt: number; updatedAt: number; agentId: string | null;
};
export const ORGANIZATION_LIMITS = { maxActiveAgents: 6, maxConcurrentAgents: 3, maxSpawnsPerRun: 3, maxSpawnsPerRound: 1, maxOrganizationChangesPerRound: 2, maxOrganizationRounds: 10 };
export type OrganizationRun = { id: string; round: number; spawns: number; roundSpawns: number; roundChanges: number; limits: typeof ORGANIZATION_LIMITS };
export const OrganizationStore = defineDoc<{ proposals: DelegationProposal[]; spawnProposals?: SpawnProposal[]; run?: OrganizationRun }>({
  kind: "delm.organization", version: 1, scope: "session",
  initial: () => ({ proposals: [] }), checkpointWhen: () => false,
});
