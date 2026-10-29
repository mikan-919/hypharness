import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { defaultConfig, Store, type Config } from "./db.ts";
import { runScheduler } from "./scheduler.ts";
import { safePath } from "./tools.ts";
import type { Runtime } from "./agent.ts";

// A scripted agent: reads its opening message and the tools it already used, and returns the next tool call.
function brain(store: Store, files: number) {
  return (ctx: { messages: Message[] }) => {
    const first = ctx.messages.find(m => m.role === "user")!.content as string | { type: string; text?: string }[];
    const opening = typeof first === "string" ? first : first.map(b => b.text ?? "").join("");
    const used = ctx.messages.filter(m => m.role === "toolResult").map(m => m.toolName);
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    const kind = opening.match(/## Current task \S+ \((\w+)/)![1];
    if (kind === "verify") {
      if (!used.includes("file_list")) return call("file_list", {});
      return call("task_finish", { result: "checked the files exist", verdict: "pass" });
    }
    if (kind === "work") {
      const n = opening.match(/write file (\d+)/)![1];
      if (!used.includes("file_write")) return call("file_write", { path: `out/${n}.txt`, content: `file ${n}\n`.repeat(50) });
      if (!used.includes("memory_write")) return call("memory_write", { content: `wrote out/${n}.txt` });
      return call("task_finish", { result: `out/${n}.txt` });
    }
    const created = store.get<{ n: number }>("select count(*) n from tasks where kind = 'work'")!.n;
    if (created < files && !used.includes("task_create")) return call("task_create", { goal: "G0", description: `write file ${created}` });
    if (created >= files && !used.includes("goal_complete")) return call("goal_complete", { id: "G0", deliverable: "out/*.txt" });
    return call("task_finish", { result: "steered" });
  };
}

function setup(config: Partial<Config>, files = 2, dir = mkdtempSync(join(tmpdir(), "hyph-"))) {
  const store = new Store(join(dir, "state.sqlite"));
  store.init("Produce the requested files", "", { ...defaultConfig, maxConcurrency: 1, ...config });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array(400).fill(brain(store, files)));
  const rt: Runtime = { store, models, model: faux.getModel(), workspace: join(dir, "workspace"), contextDir: join(dir, "contexts"), log: process.env.DEBUG ? console.log : undefined };
  return { dir, store, rt };
}

test("A: a purpose alone leads to planned, executed, independently verified work", async () => {
  const { store, rt } = setup({ organization: "dynamic" });
  const r = await runScheduler(rt);
  expect(r.status).toBe("done");
  expect(existsSync(join(rt.workspace, "out/0.txt")) && existsSync(join(rt.workspace, "out/1.txt"))).toBe(true);
  const root = store.goal("G0")!;
  expect(root.verified_by).not.toBe("lead");
  for (const t of store.all<{ verified_by: string; claimed_by: string }>("select * from tasks where kind = 'work'")) expect(t.verified_by).not.toBe(t.claimed_by);
});

test("B: the organization grows only when verification needs another agent", async () => {
  const dynamic = setup({ organization: "dynamic" });
  await runScheduler(dynamic.rt);
  expect(dynamic.store.agents().map(a => a.id).sort()).toEqual(["lead", "verifier"]);

  const single = setup({ organization: "single", maxAgents: 1 });
  const r = await runScheduler(single.rt);
  expect(r.status).toBe("done");
  expect(single.store.agents().length).toBe(1);
  expect(single.store.goal("G0")!.verified_by).toBe("lead"); // recorded as self-verification, not hidden
});

test("C: a stopped run resumes from the same state without repeating tool side effects", async () => {
  const first = setup({ maxModelCalls: 3 });
  expect((await runScheduler(first.rt)).status).toBe("budget");
  // Simulate a crash after a tool ran but before its result reached the saved context.
  const ep = first.store.get<{ id: string; messages: string }>("select * from episodes where status = 'running'")!;
  const messages: Message[] = JSON.parse(ep.messages);
  expect(messages.at(-1)).toMatchObject({ role: "toolResult", toolName: "file_write" });
  first.store.run("update episodes set messages = ? where id = ?", JSON.stringify(messages.slice(0, -1)), ep.id);
  first.store.run("update tasks set lease_until = 0"); // the stop outlasted the lease
  first.store.db.close();

  const second = setup({}, 2, first.dir);
  second.store.setMeta("config", JSON.stringify({ ...second.store.config, maxModelCalls: 100 }));
  expect((await runScheduler(second.rt)).status).toBe("done");
  const resumed: Message[] = JSON.parse(second.store.get<{ messages: string }>("select messages from episodes where id = ?", ep.id)!.messages);
  const results = resumed.filter(m => m.role === "toolResult" && m.toolName === "file_write");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({ isError: false });
  expect(second.store.get<{ n: number }>("select count(*) n from ops where episode = ?", ep.id)!.n).toBe(resumed.filter(m => m.role === "toolResult").length);
});

test("D: model input stays bounded as the amount of work grows", async () => {
  const { store, rt } = setup({ organization: "single", maxAgents: 1 }, 12);
  expect((await runScheduler(rt, 200)).status).toBe("done");
  const sizes = store.all<{ size: number }>("select max(prompt_chars) size from usage group by task order by min(id)").map(r => r.size);
  const early = Math.max(...sizes.slice(0, 4)), late = Math.max(...sizes.slice(-4));
  expect(late).toBeLessThan(early * 1.5);
});

test("workspace paths cannot escape, including through symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-ws-"));
  symlinkSync(tmpdir(), join(dir, "link"));
  expect(safePath(dir, "a/b.txt")).toEndWith("a/b.txt");
  expect(() => safePath(dir, "../x")).toThrow();
  expect(() => safePath(dir, "link/x")).toThrow();
});

test("a provider that keeps failing stops the run instead of spending the budget", async () => {
  const { rt } = setup({});
  const faux = fauxProvider();
  rt.models.setProvider(faux.provider);
  faux.setResponses(Array(50).fill(fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" })));
  const r = await runScheduler({ ...rt, model: faux.getModel() });
  expect(r.status).toBe("error");
  expect(r.modelCalls).toBe(3);
});

test("fixed organization: three agents work concurrently, verify each other, and stay three", async () => {
  const { store, rt } = setup({ organization: "fixed", maxAgents: 3, maxConcurrency: 3 }, 4);
  const r = await runScheduler(rt);
  expect(r.status).toBe("done");
  expect(r.agents).toBe(3);
  expect(r.organizationChanges).toBe(0);
  const work = store.all<{ verified_by: string; claimed_by: string }>("select * from tasks where kind = 'work'");
  expect(work).toHaveLength(4);
  for (const t of work) expect(t.verified_by).not.toBe(t.claimed_by);
  expect(store.goal("G0")!.verified_by).not.toBe("lead");
});
