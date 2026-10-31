import { expect, test } from "bun:test";
import { openResident, setOrder } from "./resident.ts";
import { runWorkerPool } from "./scheduler.ts";
import type { Runtime } from "./agent.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { history, reply, waitForFront } from "./chat.ts";
import { tools, type ToolContext } from "./tools.ts";

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

test("knowledge created by a worker is assigned a domain immediately", () => {
  const store = openResident(":memory:"); store.addAgent("worker", "worker", null);
  const context = { store, agent: store.agent("worker")! } as ToolContext;
  tools.knowledge_add!.run(context, { gist: "fact", summary: "fact", raw: "fact", source: "file" });
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge")!.n).toBe(1);
  store.db.close();
});

test("front waits on usage limits before retrying", async () => {
  let calls = 0, waited = 0;
  const answer = await waitForFront(async () => ++calls === 1 ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" }) : fauxAssistantMessage("ok"), true, async ms => { waited = Number(ms); });
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
