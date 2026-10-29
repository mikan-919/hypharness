import { createHash } from "node:crypto";
import type { Message } from "@earendil-works/pi-ai";
import type { ContextState } from "./state.ts";
import { estimate } from "./state.ts";

export function prefixHash(messages: readonly Message[]) { return createHash("sha256").update(JSON.stringify(messages)).digest("hex"); }
export function render(messages: readonly Message[], state: Readonly<ContextState>, modelLimit = state.budget.maxTokens): Message[] {
  const checkpoint = state.checkpoint;
  let suffix = messages;
  const end = checkpoint.prefixStart + checkpoint.prefixLength;
  if (checkpoint.coveredThroughEntryId !== null && checkpoint.prefixLength > 0 && end < messages.length && prefixHash(messages.slice(checkpoint.prefixStart, end)) === checkpoint.prefixHash) {
    const covered = messages.slice(checkpoint.prefixStart, end);
    const retained = messages.slice(end);
    if (messages.slice(0, checkpoint.prefixStart).every(m => m.role === "system") && retained.some(m => m.role === "user") && !covered.some(m => m.role === "system")) suffix = [...messages.slice(0, checkpoint.prefixStart), ...retained];
  }
  const clm = [checkpoint.summary && `Checkpoint:\n${checkpoint.summary}`, state.workingMemory && `Working memory:\n${state.workingMemory}`].filter(Boolean).join("\n\n");
  const result: Message[] = [...suffix];
  if (clm) {
    const index = result.findIndex(m => m.role !== "system");
    result.splice(index < 0 ? result.length : index, 0, { role: "system", content: `<clm>\n${clm}\n</clm>`, timestamp: 0 });
  }
  if (estimate(result) + state.budget.reserveTokens > Math.min(state.budget.maxTokens, modelLimit)) throw new Error("Context budget exceeded; update the checkpoint or reduce working memory");
  return result;
}
