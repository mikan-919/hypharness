import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { openChat, organize, rememberOld } from "./chat.ts";
import { defaultConfig, Store } from "./db.ts";
import { ingestConversation, stewardOf } from "./memory.ts";
import { searchTerms, tools, type ToolContext } from "./tools.ts";
import { eligible, ORGANIZE_EVERY } from "./triggers.ts";

const ctxFor = (store: Store, agent: string, task: string) => ({ store, agent: store.agent(agent)!, task: store.task(task)!, workspace: "", contextDir: "", episode: "e", messages: [] }) as ToolContext;

test("each memory domain gets its own dormant steward, and ingesting a benchmark conversation fires no organizing", () => {
  const store = new Store(":memory:");
  store.init("p", "", defaultConfig);
  ingestConversation(store, "DATE: 1 May\nCONVERSATION:\nAnn said, \"I adopted a cat.\"\nDATE: 2 May\nCONVERSATION:\nBob said, \"I moved.\"");
  expect(store.all<{ steward: string }>("select steward from domains order by id").map(d => d.steward)).toEqual([stewardOf("D-s1"), stewardOf("D-s2")]);
  expect(store.agent(stewardOf("D-s1"))!.status).toBe("dormant");
  expect(store.get("select 1 from tasks where kind = 'organize'")).toBeUndefined();
  // Stewards take only organizing work, and only stewards take it.
  expect(eligible(store, store.agent(stewardOf("D-s1"))!, { kind: "verify" })).toBe(false);
  expect(eligible(store, store.agent("lead")!, { kind: "organize" })).toBe(false);
});

test("chat memory that grows past the threshold sets its steward to organize, and the organizing pass runs it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-chat-org-"));
  const store = openChat(join(dir, "state.sqlite"));
  const add = (n: number) => { for (let i = 0; i < n; i++) store.run("insert into chat(role, text, at) values('user', ?, ?)", `Fact number ${store.get<{ n: number }>("select count(*) n from chat")!.n}.`, Date.UTC(2026, 9, 30)); };
  add(6 + ORGANIZE_EVERY - 1);
  rememberOld(store);
  expect(store.get("select 1 from tasks where kind = 'organize'")).toBeUndefined();
  add(1);
  rememberOld(store);
  const task = store.get<{ assignee: string; target: string; budget: number }>("select * from tasks where kind = 'organize'")!;
  expect([task.assignee, task.target]).toEqual([stewardOf("D-chat-2026-10-30"), "D-chat-2026-10-30"]);
  expect(store.agent(task.assignee)!.status).toBe("active");

  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  const steward = (ctx: { messages: Message[] }) => ctx.messages.some(m => m.role === "toolResult")
    ? fauxAssistantMessage([fauxToolCall("task_finish", { result: "kept as is: one topic" })], { stopReason: "toolUse" })
    : fauxAssistantMessage([fauxToolCall("domain_list", {})], { stopReason: "toolUse" });
  faux.setResponses([steward, steward]);
  const r = await organize({ models, model: faux.getModel() }, store, dir);
  expect(r?.status).toBe("stalled");
  expect(store.get<{ status: string }>("select status from tasks where kind = 'organize'")!.status).toBe("done");
  expect(store.meta("organized:D-chat-2026-10-30")).toBe(String(ORGANIZE_EVERY));
  // The chat's G0 is never steered: only triggered work ran.
  expect(store.get("select 1 from tasks where kind = 'steer'")).toBeUndefined();
});

test("stewards merge across domains by asking for a transfer and merging what they were handed", () => {
  const store = new Store(":memory:");
  store.init("p", "", defaultConfig);
  ingestConversation(store, "DATE: 1 May\nCONVERSATION:\nAnn said, \"I adopted a cat.\"\nDATE: 2 May\nCONVERSATION:\nAnn said, \"The cat is sick.\"");
  const a = stewardOf("D-s1"), b = stewardOf("D-s2");
  const claim = (agent: string) => {
    const t = store.get<{ id: string }>("select id from tasks where kind = 'organize' and assignee = ? and status = 'open'", agent)!.id;
    expect(store.claim(t, agent)).toBe(true);
    return ctxFor(store, agent, t);
  };
  store.tx(() => store.addTask({ goal: "G0", kind: "organize", author: "host", assignee: a, target: "D-s1", description: "organize D-s1" }));
  const ca = claim(a);
  tools.domain_request!.run(ca, { domain: "D-s2", reason: "both are about the cat" });
  tools.task_finish!.run(ca, { result: "asked for D-s2" });
  const cb = claim(b);
  expect(cb.task.description).toContain("both are about the cat");
  tools.domain_transfer!.run(cb, { id: "D-s2", to: a });
  tools.task_finish!.run(cb, { result: "handed over" });
  const ca2 = claim(a);
  tools.domain_merge!.run(ca2, { ids: ["D-s1", "D-s2"], name: "Cat", description: "Ann's cat" });
  const merged = store.get<{ id: string; steward: string }>("select id, steward from domains where status = 'active'")!;
  expect(merged.steward).toBe(a);
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge where domain = ?", merged.id)!.n).toBe(2);
});

test("knowledge_search finds Japanese without spaces, and lists one sentence per turn, the one that matches", () => {
  const store = new Store(":memory:");
  store.init("p", "", defaultConfig);
  ingestConversation(store, "DATE: 1 May\nCONVERSATION:\nUser said, \"うちの猫はモチという名前です。来週は京都に行きます。\"\nBob said, \"I like cats. Cats are calm. My cat sleeps a lot.\"");
  const search = (query: string) => String(tools.knowledge_search!.run({ store } as ToolContext, { query }));
  expect(searchTerms("猫の名前は？")).toEqual(["猫の", "の名", "名前", "前は"]);
  expect(search("猫の名前は？").split("\n")[0]).toContain("うちの猫はモチという名前です。");
  const cats = search("sleeps cat").split("\n");
  expect(cats.filter(l => l.includes("Bob:"))).toEqual([expect.stringContaining("My cat sleeps a lot.")]);
});
