import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { ConversationId, Harness } from "@earendil-works/pi-durable";
import { AgentContext } from "./state.ts";

const queues = new Map<number, Promise<void>>();
export async function syncMirror(harness: Harness, id: ConversationId, context: Context, root = "contexts") {
  const previous = queues.get(id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const state = await harness.snapshot(AgentContext, id, context);
    if (!state) return;
    const directory = join(root, String(id));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.LIVE_CTX.${crypto.randomUUID()}.tmp`);
    const content = `# Context ${id}\n\nVersion: ${state.version}\n\n## Checkpoint\n\n${state.checkpoint.summary}\n\n## Working memory\n\n${state.workingMemory}\n`;
    const target = join(directory, "LIVE_CTX.md");
    try { if (await readFile(target, "utf8") === content) return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, target);
  });
  queues.set(id, next);
  try { await next; } finally { if (queues.get(id) === next) queues.delete(id); }
}
