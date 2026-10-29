import { defineDoc } from "@earendil-works/pi-durable";

export type DelegationProposal = {
  id: string; author: string; reviewer: string | null; taskId: string; taskRevision: number;
  targetAgentId: string; targetRevision: number; reason: string; benefits: string; risks: string;
  status: "proposed" | "under_review" | "approved" | "rejected" | "applied";
  review: string; createdAt: number; updatedAt: number;
};
export const OrganizationStore = defineDoc<{ proposals: DelegationProposal[] }>({
  kind: "delm.organization", version: 1, scope: "session",
  initial: () => ({ proposals: [] }), checkpointWhen: () => false,
});
