import { defineDoc } from "@earendil-works/pi-durable";

export type Memory = {
  id: string;
  author: string;
  content: string;
  createdAt: number;
};

export const SharedMemory = defineDoc<{
  memories: Memory[];
}>({
  kind: "delm.shared-memory",
  version: 1,
  scope: "session",
  initial: () => ({ memories: [] }),
  checkpointWhen: () => false,
});
