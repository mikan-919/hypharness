import { defineDoc } from "@earendil-works/pi-durable";
import type { Role } from "./agents.ts";

export type TaskState = "open" | "claimed" | "completed" | "split" | "failed" | "cancelled";
export type BoardTask = {
  id: string; type: string; description: string; role: Role; state: TaskState;
  owner: string | null; token: string | null; leaseUntil: number | null; revision: number;
  parent: string | null; dependencies: string[]; knowledgeId: string | null;
  result: string | null; createdAt: number; updatedAt: number;
  goalId?: string;
};
export type Board = { tasks: BoardTask[]; operations: Record<string, { fingerprint: string; result: string }> };
export const TaskBoard = defineDoc<Board>({
  kind: "delm.task-board", version: 1, scope: "session",
  initial: () => ({ tasks: [], operations: {} }), checkpointWhen: () => false,
});

export function newTask(input: { id: string; type: string; description: string; role: Role; parent?: string | null; dependencies?: string[]; knowledgeId?: string | null; goalId?: string }, now: number): BoardTask {
  return { ...input, state: "open", owner: null, token: null, leaseUntil: null, revision: 0,
    parent: input.parent ?? null, dependencies: input.dependencies ?? [], knowledgeId: input.knowledgeId ?? null,
    result: null, createdAt: now, updatedAt: now };
}
export function addTask(board: Board, task: BoardTask) {
  if (board.tasks.some(t => t.id === task.id)) throw new Error("Task ID already exists");
  if (task.dependencies.includes(task.id) || task.dependencies.some(id => !board.tasks.some(t => t.id === id))) throw new Error("Invalid dependencies");
  board.tasks.push(task);
}
export function ready(board: Board, task: BoardTask, now: number): boolean {
  const done = (id: string, seen: Set<string>): boolean => {
    if (seen.has(id)) return false;
    const dependency = board.tasks.find(t => t.id === id);
    if (!dependency) return false;
    if (dependency.state === "completed") return true;
    if (dependency.state !== "split") return false;
    const children = board.tasks.filter(t => t.parent === id);
    return children.length > 0 && children.every(t => done(t.id, new Set([...seen, id])));
  };
  return (task.state === "open" || (task.state === "claimed" && (task.leaseUntil ?? 0) <= now)) &&
    task.dependencies.every(id => done(id, new Set()));
}
export function checkCycles(board: Board) {
  const visit = (id: string, path: Set<string>) => {
    if (path.has(id)) throw new Error("Circular dependency");
    const task = board.tasks.find(t => t.id === id);
    if (!task) throw new Error("Missing dependency");
    const next = new Set([...path, id]);
    for (const dependency of task.dependencies) visit(dependency, next);
    if (task.state === "split") for (const child of board.tasks.filter(t => t.parent === id)) visit(child.id, next);
  };
  for (const task of board.tasks) visit(task.id, new Set());
}
export function owned(task: BoardTask, owner: string, token: string, revision: number, now: number) {
  if (task.state !== "claimed" || task.owner !== owner || task.token !== token || task.revision !== revision || (task.leaseUntil ?? 0) <= now) throw new Error("Claim is stale or not owned");
}
export function operation(board: Board, id: string, fingerprint: string, fn: () => string): string {
  const existing = board.operations[id];
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new Error("Operation ID reused with different arguments");
    return existing.result;
  }
  const result = fn();
  board.operations[id] = { fingerprint, result };
  return result;
}
export function touch(task: BoardTask, now: number) { task.revision++; task.updatedAt = now; }
