
import { defineDoc } from "@earendil-works/pi-durable";

export type Evidence = {
  claim: string;
  quote: string;
};

export type Knowledge = {
  id: string;
  author: string;

  raw: string;
  summary: Evidence[];
  gist: string;

  status: "proposed" | "source_checked" | "verified" | "rejected";

  sourceReviewer?: string;
  gistReviewer?: string;
  reviewNote?: string;
};

export const KnowledgeStore = defineDoc<{
  entries: Knowledge[];
}>({
  kind: "delm.knowledge",
  version: 1,
  scope: "session",
  initial: () => ({ entries: [] }),
  checkpointWhen: () => false,
});
