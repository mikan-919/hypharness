import type { Context } from "@earendil-works/chord";
import type { Harness } from "@earendil-works/pi-durable";
import { KnowledgeStore } from "./knowledge.ts";
import { TaskBoard, addTask, newTask } from "./tasks.ts";

export const reviewTaskId = (knowledgeId: string, stage: "source" | "gist") => `review:${stage}:${knowledgeId}`;
export async function reconcileKnowledge(harness: Harness, context: Context, now = Date.now()) {
  await harness.commit(async tx => {
    const knowledge = await tx.doc(KnowledgeStore);
    const board = await tx.doc(TaskBoard);
    for (const entry of knowledge.entries) {
      const stage = entry.status === "proposed" ? "source" : entry.status === "source_checked" ? "gist" : null;
      for (const task of board.tasks) {
        if (task.knowledgeId !== entry.id || !task.type.startsWith("review_") || task.type === `review_${stage}` || (task.state !== "open" && task.state !== "claimed")) continue;
        task.state = "cancelled";
        task.token = null;
        task.leaseUntil = null;
        task.revision++;
        task.updatedAt = now;
      }
      if (!stage) continue;
      const id = reviewTaskId(entry.id, stage);
      if (board.tasks.some(t => t.id === id)) continue;
      addTask(board, newTask({ id, type: `review_${stage}`, description: `Review knowledge ${entry.id} (${stage})`, role: stage === "source" ? "source_reviewer" : "gist_reviewer", knowledgeId: entry.id }, now));
    }
  }, context);
}
