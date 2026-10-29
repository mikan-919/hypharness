import { defineDoc } from "@earendil-works/pi-durable";

export const DEFAULT_BUDGET = { maxTokens: 32768, reserveTokens: 4096, keepRecentTokens: 4096 };
export const MAX_HISTORY = 30;
export type Checkpoint = { coveredThroughEntryId: number | null; summary: string; prefixHash: string; prefixStart: number; prefixLength: number };
export type ContextRevision = { version: number; workingMemory: string; checkpoint: Checkpoint; operation: string; at: number; description: string };
export type ContextState = {
  version: number; workingMemory: string; checkpoint: Checkpoint;
  budget: { maxTokens: number; reserveTokens: number; keepRecentTokens: number };
  updatedAt: number; history: ContextRevision[]; operations: Record<string, { fingerprint: string; version: number }>;
};
const emptyCheckpoint = (): Checkpoint => ({ coveredThroughEntryId: null, summary: "", prefixHash: "", prefixStart: 0, prefixLength: 0 });
export const AgentContext = defineDoc<ContextState>({
  kind: "delm.agent-context", version: 1, scope: "conversation", history: "latest", fork: "initial",
  initial: () => ({ version: 0, workingMemory: "", checkpoint: emptyCheckpoint(), budget: { ...DEFAULT_BUDGET }, updatedAt: 0, history: [{ version: 0, workingMemory: "", checkpoint: emptyCheckpoint(), operation: "initial", at: 0, description: "" }], operations: {} }),
  checkpointWhen: () => false,
});
export const estimate = (value: unknown) => Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
export function checkBudget(state: ContextState) {
  if (state.budget.reserveTokens < 0 || state.budget.keepRecentTokens < 0 || state.budget.maxTokens <= state.budget.reserveTokens + state.budget.keepRecentTokens || estimate(state.workingMemory) + estimate(state.checkpoint.summary) > state.budget.maxTokens - state.budget.reserveTokens - state.budget.keepRecentTokens) throw new Error("Context budget exceeded");
}
export function revise(state: ContextState, expected: number, operation: string, description: string, now: number, change: () => void, force = false) {
  if (state.version !== expected) throw new Error("Context version conflict");
  const previousMemory = state.workingMemory, previousCheckpoint = JSON.stringify(state.checkpoint);
  change(); checkBudget(state);
  if (!force && previousMemory === state.workingMemory && previousCheckpoint === JSON.stringify(state.checkpoint)) return state.version;
  state.version++; state.updatedAt = now;
  state.history.push({ version: state.version, workingMemory: state.workingMemory, checkpoint: { ...state.checkpoint }, operation, at: now, description });
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
  return state.version;
}
