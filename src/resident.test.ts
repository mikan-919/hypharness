import { expect, test } from "bun:test";
import { openResident, setOrder } from "./resident.ts";
import { runWorkerPool } from "./scheduler.ts";
import type { Runtime } from "./agent.ts";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { history, reply, waitForFront } from "./chat.ts";
import { tools, type ToolContext } from "./tools.ts";
import { remember } from "./resident-memory.ts";

test("orders change only the resident purpose and request each goal owner to reconsider", () => {
  const store = openResident(":memory:");
  store.addAgent("owner", "worker", null);
  store.run("insert into goals(id, parent, description, status, owner, created_at) values('G1', 'G0', 'first', 'open', 'owner', 1)");
  const rev = store.goal("G0")!.rev;
  setOrder(store, "new purpose");
  expect(store.purpose).toBe("new purpose");
  expect(store.goal("G0")).toMatchObject({ description: "new purpose", rev: rev + 1, status: "review" });
  expect(store.goal("G1")!.description).toBe("first");
  expect(store.all("select kind, assignee, goal from tasks")).toEqual([{ kind: "steer", assignee: "owner", goal: "G1" }]);
  expect(store.get<{ n: number }>("select count(*) n from log where event = 'order_changed'")!.n).toBe(1);
  expect(store.agent("lead")).toBeUndefined();
  store.db.close();
});

test("knowledge created by a worker is assigned a domain immediately", async () => {
  const store = openResident(":memory:"); store.addAgent("worker", "worker", null);
  const context = { store, agent: store.agent("worker")!, embed: async () => [1, 0] } as unknown as ToolContext;
  await tools.knowledge_add!.run(context, { gist: "fact", summary: "fact", raw: "fact", source: "file" });
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge")!.n).toBe(1);
  store.db.close();
});

test("knowledge tools assign results to the nearest domain", async () => {
  const store = openResident(":memory:"); store.addAgent("worker", "worker", null);
  const embed = async (text: string) => text.includes("near") ? [1, 0] : [0, 1];
  await remember(store, embed, "far", "test");
  store.run("insert into domains(id, name, description, steward, status) values('D-z', 'z', 'z', 'z', 'active')");
  const [near] = await remember(store, embed, "near", "test");
  store.run("update domain_knowledge set domain = 'D-z' where knowledge = ?", near);
  const context = { store, agent: store.agent("worker")!, task: { id: "task" }, embed, fetchPage: async () => ({ url: "https://example.org/page", text: "near fetch" }) } as unknown as ToolContext;
  await tools.knowledge_add!.run(context, { gist: "near", summary: "near", raw: "near direct", source: "direct" });
  await tools.web_fetch!.run(context, { url: "https://example.org/page" });
  const original = globalThis.fetch, key = process.env.PARALLEL_API_KEY;
  try {
    process.env.PARALLEL_API_KEY = "test-key";
    globalThis.fetch = (async () => Response.json({ results: [{ url: "https://example.org/search", title: "result", excerpts: ["near search"] }] })) as unknown as typeof fetch;
    await tools.web_search!.run(context, { objective: "test", queries: ["test"] });
  } finally { globalThis.fetch = original; if (key === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = key; }
  for (const source of ["direct", "https://example.org/page", "https://example.org/search"]) {
    expect(store.get<{ domain: string }>("select d.domain from domain_knowledge d join knowledge k on k.id = d.knowledge where k.source = ?", source)!.domain).toBe("D-z");
  }
  store.db.close();
});

test("front waits on usage limits before retrying", async () => {
  let calls = 0, waited = 0;
  const waits: string[] = [];
  const answer = await waitForFront(async () => ++calls === 1 ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" }) : fauxAssistantMessage("ok"), true, async ms => { waited = Number(ms); }, e => waits.push(e));
  expect(waits).toEqual(["usage limit"]);
  expect(answer.stopReason).not.toBe("error");
  expect(calls).toBe(2);
  expect(waited).toBe(60_000);
});

test("resident chat remembers both sides immediately and retains a six-message window", async () => {
  const store = openResident(":memory:");
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array(4).fill(fauxAssistantMessage("answer.")));
  for (let i = 0; i < 4; i++) await reply({ models, model: faux.getModel() }, store, `question ${i}.`, async () => [1, 0]);
  expect(history(store).map(m => m.remembered)).toEqual([1, 1, 0, 0, 0, 0, 0, 0]);
  expect(store.get<{ n: number }>("select count(*) n from memory_vectors")!.n).toBe(8);
  store.db.close();
});

test("a free worker takes another task without waiting for the slow episode", async () => {
  const store = openResident(":memory:");
  store.setMeta("config", JSON.stringify({ ...store.config, maxConcurrency: 2 }));
  for (const id of ["slow", "fast"]) store.addAgent(id, "worker", null);
  store.run("insert into goals(id, parent, description, status, owner, created_at) values('G1', 'G0', 'work', 'open', 'slow', 1)");
  store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "slow", description: "slow" });
  store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "fast", description: "fast one" });
  store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "fast", description: "fast two" });
  const controller = new AbortController();
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const completed: string[] = [];
  const pool = runWorkerPool({ store } as Runtime, controller.signal, async (_rt, agent, task) => {
    if (agent.id === "slow") await slow;
    store.run("update tasks set status = 'done' where id = ?", task.id);
    completed.push(task.description);
    if (task.description === "fast two") { controller.abort(); release(); }
    return "finished";
  });
  await pool;
  expect(completed.indexOf("fast two")).toBeLessThan(completed.indexOf("slow"));
  store.db.close();
});

test("notifications wake an idle pool and changes before waiting are not lost", async () => {
  const store = openResident(":memory:"), controller = new AbortController();
  const before = store.changeVersion;
  setOrder(store, "work");
  await store.waitForChange(before, controller.signal, 60_000);
  store.addAgent("worker", "worker", null);
  store.run("insert into goals(id, parent, description, status, owner, created_at) values('G1', 'G0', 'work', 'review', 'worker', 1)");
  let completed = false;
  const pool = runWorkerPool({ store } as Runtime, controller.signal, async (_rt, _agent, task) => {
    completed = true; store.run("update tasks set status = 'done' where id = ?", task.id); controller.abort(); return "finished";
  });
  await Bun.sleep(20);
  store.addTask({ goal: "G1", kind: "work", author: "host", assignee: "worker", description: "wake" });
  await Promise.race([pool, Bun.sleep(1000).then(() => { throw new Error("Pool did not wake"); })]);
  expect(completed).toBe(true);
  store.db.close();
});

test("the resident front hands a request for work to the organization as the purpose instead of doing it", async () => {
  const store = openResident(":memory:");
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("order_set", { purpose: "RSI の論文を調べてレポートにまとめる" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("調査を始めました。"),
  ]);
  const r = await reply({ models, model: faux.getModel() }, store, "RSI の論文を調べてレポートにまとめて", async () => [1, 0]);
  expect(r.reply).toBe("調査を始めました。");
  expect(store.purpose).toBe("RSI の論文を調べてレポートにまとめる");
  expect(store.get<{ n: number }>("select count(*) n from log where event = 'order_changed'")!.n).toBe(1);
});
