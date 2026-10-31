import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { call, marketBrain } from "./fixtures/market-brain.ts";
import { defaultConfig, Store, type Config } from "./db.ts";
import { runScheduler, steer } from "./scheduler.ts";
import { canonicalUrl, safePath, toolSchemas, tools, type ToolContext } from "./tools.ts";
import type { Runtime } from "./agent.ts";

// A scripted market organization: lead splits G0 into one subgoal per file, each funded task writes its file.
function brain(files: number) {
  return marketBrain(Array.from({ length: files }, (_, n) => `write file ${n}`), (opening, used) => {
    const n = opening.match(/write file (\d+)/)![1];
    if (!used.includes("file_write")) return call("file_write", { path: `out/${n}.txt`, content: `file ${n}\n`.repeat(50) });
    if (!used.includes("memory_write")) return call("memory_write", { content: `wrote out/${n}.txt` });
    return call("task_finish", { result: `out/${n}.txt` });
  });
}

function setup(config: Partial<Config>, files = 2, dir = mkdtempSync(join(tmpdir(), "hyph-"))) {
  const store = new Store(join(dir, "state.sqlite"));
  store.init("Produce the requested files", "", { ...defaultConfig, maxConcurrency: 1, ...config });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array(400).fill(brain(files)));
  const rt: Runtime = { store, models, model: faux.getModel(), workspace: join(dir, "workspace"), contextDir: join(dir, "contexts"), log: process.env.DEBUG ? console.log : undefined };
  return { dir, store, rt };
}

test("A: a purpose alone leads to planned, executed, independently verified work", async () => {
  const { store, rt } = setup({});
  const r = await runScheduler(rt);
  expect(r.status).toBe("done");
  expect(existsSync(join(rt.workspace, "out/0.txt")) && existsSync(join(rt.workspace, "out/1.txt"))).toBe(true);
  const root = store.goal("G0")!;
  expect(root.verified_by).not.toBe("lead");
  for (const t of store.all<{ verified_by: string; claimed_by: string }>("select * from tasks where kind = 'work'")) expect(t.verified_by).not.toBe(t.claimed_by);
  // Each tool result names its own position, so a range can be given to context_edit without an outline.
  const msgs = JSON.parse(store.get<{ messages: string }>("select messages from episodes limit 1")!.messages) as Message[];
  msgs.forEach((m, i) => { if (m.role === "toolResult") expect((m.content[0] as { text: string }).text).toMatch(new RegExp(`\\[#${i} · live context: ~\\d+ tokens\\]$`)); });
});

test("C: a stopped run resumes from the same state without repeating tool side effects", async () => {
  // Ten calls: lead splits G0 into two subgoals (3), three investors fund each (6), and the first worker writes its file (1).
  const first = setup({ maxModelCalls: 10 });
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
  const { store, rt } = setup({}, 12);
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

test("shell confines writes and does not expose the host environment", async () => {
  if (!Bun.which("bwrap")) return;
  const { store, rt, dir } = setup({ allowShell: true });
  const c = { store, agent: store.agent("lead")!, task: { id: "T-1" }, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages: [] } as unknown as ToolContext;
  await Bun.write(join(dir, "outside"), "private");
  const probe = await tools.shell!.run(c, { command: "printf ok" });
  if (!String(probe).includes("exit 0\nok")) return; // User namespaces may be disabled by the host.
  mkdirSync(join(rt.workspace, "nested"));
  await Bun.write(join(rt.workspace, "nested", ".env"), "fixture");
  await Bun.write(join(rt.workspace, "nested", "auth.json"), "fixture");
  const protectedResult = await tools.shell!.run(c, { command: "test ! -s nested/.env && test ! -s nested/auth.json && bun --version >/dev/null && printf protected" });
  expect(protectedResult).toContain("exit 0\nprotected");
  const result = await tools.shell!.run(c, { command: `printf '%s' "${"${HOME}"}"; test ! -e '${dir}/outside' && echo hidden; echo written > result` });
  expect(result).toContain("exit 0\n/tmphidden");
  expect(await Bun.file(join(rt.workspace, "result")).text()).toBe("written\n");
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

test("web_search sends the query to Parallel and returns ranked excerpts", async () => {
  const { store, rt } = setup({});
  const c = { store, agent: store.agent("lead")!, task: { id: "T-1" }, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages: [] } as unknown as ToolContext;
  const args = { objective: "Find Bun's SQLite API", queries: ["bun sqlite api"], include_domains: ["bun.com"] };
  const original = globalThis.fetch, key = process.env.PARALLEL_API_KEY;
  try {
    delete process.env.PARALLEL_API_KEY;
    expect(toolSchemas().map(t => t.name)).not.toContain("web_search");
    await expect(tools.web_search!.run(c, args)).rejects.toThrow("not configured");
    process.env.PARALLEL_API_KEY = "test-key";
    expect(toolSchemas().map(t => t.name)).toContain("web_search");
    let sent: { url: string; init: RequestInit } | undefined;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent = { url, init };
      return Response.json({ search_id: "s", session_id: "T-1", warnings: null, results: [{ url: "https://bun.com/docs/api/sqlite", title: "SQLite", publish_date: null, excerpts: ["bun:sqlite is built in"] }] });
    }) as typeof fetch;
    const out = await tools.web_search!.run(c, args);
    expect(sent!.url).toBe("https://api.parallel.ai/v1/search");
    expect((sent!.init.headers as Record<string, string>)["x-api-key"]).toBe("test-key");
    expect(JSON.parse(sent!.init.body as string)).toMatchObject({ search_queries: ["bun sqlite api"], mode: "fast", session_id: "T-1", advanced_settings: { source_policy: { include_domains: ["bun.com"] } } });
    expect(out).toMatch(/^\[1\] K-\S+ SQLite\nhttps:\/\/bun.com\/docs\/api\/sqlite\nbun:sqlite is built in$/);
    // Results become hypotheses with the URL as source, once per URL.
    await tools.web_search!.run(c, args);
    expect(store.all("select gist, source, status from knowledge")).toEqual([{ gist: "SQLite", source: "https://bun.com/docs/api/sqlite", status: "hypothesis" }]);
    expect(out).toContain(store.get<{ id: string }>("select id from knowledge")!.id);
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = key;
  }
});

test("versions and copies of one paper become one knowledge item, and knowledge_merge folds the ones recorded before", async () => {
  const { store, rt } = setup({});
  const c = { store, agent: store.agent("lead")!, task: { id: "T-1", goal: "G0" }, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages: [] } as unknown as ToolContext;
  expect(canonicalUrl("https://arxiv.org/html/2401.10020v2#S3")).toBe("https://arxiv.org/abs/2401.10020");
  expect(canonicalUrl("https://ar5iv.labs.arxiv.org/html/2504.15228")).toBe("https://arxiv.org/abs/2504.15228");
  expect(canonicalUrl("https://www.Example.org/a/?q=1#top")).toBe("https://example.org/a/?q=1");
  const original = globalThis.fetch, key = process.env.PARALLEL_API_KEY;
  try {
    process.env.PARALLEL_API_KEY = "test-key";
    const result = (url: string, title: string) => ({ url, title, publish_date: null, excerpts: [title] });
    globalThis.fetch = (async () => Response.json({ results: [
      result("https://arxiv.org/abs/2401.10020", "Self-Rewarding Language Models"),
      result("https://arxiv.org/pdf/2401.10020v2", "[2401.10020] Self-Rewarding LMs"),
      result("https://proceedings.mlr.press/v235/yuan24d.html", "Self-Rewarding Language Models"),
      // The same work under a site's name, an arXiv ID, or a repository prefix is still one item.
      result("https://arxiv.org/abs/2310.02304", "[2310.02304] Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation"),
      result("https://openreview.net/forum?id=46Zgqo4QIU", "Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation | OpenReview"),
      result("https://opt-ml.org/papers/2023/paper21.pdf", "Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation"),
      result("https://github.com/microsoft/stop", "GitHub - microsoft/stop: Self-Taught Optimizer (STOP): Recursively Self-Improving Code Generation · GitHub"),
      // A different work with a similar title stays separate.
      result("https://arxiv.org/abs/2504.15228", "A Self-Improving Coding Agent | alphaXiv"),
    ] })) as unknown as typeof fetch;
    const out = await tools.web_search!.run(c, { objective: "x", queries: ["self rewarding"] });
    const ids = [...out.matchAll(/^\[\d\] (K-\S+)/gm)].map(m => m[1]);
    expect(new Set(ids.slice(0, 3)).size).toBe(1);
    expect(new Set(ids.slice(3, 7)).size).toBe(1);
    expect(new Set(ids).size).toBe(3);
    expect(store.all("select source from knowledge order by created_at")).toEqual([{ source: "https://arxiv.org/abs/2401.10020" }, { source: "https://arxiv.org/abs/2310.02304" }, { source: "https://arxiv.org/abs/2504.15228" }]);
    // A fetched page replaces the shorter search excerpt instead of adding an item.
    const page = { ...c, fetchPage: async () => ({ url: "https://arxiv.org/html/2401.10020v3", text: "full text of the paper, longer than the excerpt" }) } as ToolContext;
    expect(await tools.web_fetch!.run(page, { url: "https://arxiv.org/html/2401.10020v3" })).toStartWith(`${ids[0]} `);
    expect(store.get<{ n: number }>("select count(*) n from knowledge")!.n).toBe(3);
    expect(store.get<{ raw: string }>("select raw from knowledge where id = ?", ids[0])!.raw).toBe("full text of the paper, longer than the excerpt");
  } finally {
    globalThis.fetch = original;
    if (key === undefined) delete process.env.PARALLEL_API_KEY; else process.env.PARALLEL_API_KEY = key;
  }

  // Duplicates recorded before (claims, or rows from older runs) are folded by an agent.
  const add = (gist: string) => tools.knowledge_add!.run(c, { gist, summary: gist, raw: gist, source: "inference" }) as string;
  const [a, b] = [add("STaR bootstraps reasoning"), add("STaR bootstraps reasoning from its own rationales")].map(r => r.match(/K-\S+/)![0]);
  store.run("insert into domains(id, name, description, steward, status) values('D1', 'papers', '', 'lead', 'active')");
  store.run("insert into domain_knowledge(domain, knowledge) values('D1', ?)", b);
  expect(() => tools.knowledge_merge!.run(c, { keep: a, duplicates: [a], reason: "x" })).toThrow("its own duplicate");
  tools.knowledge_merge!.run(c, { keep: a, duplicates: [b], reason: "same claim" });
  expect(store.get("select status, merged_into from knowledge where id = ?", b)).toEqual({ status: "merged", merged_into: a });
  expect(store.all("select knowledge from domain_knowledge")).toEqual([{ knowledge: a }]);
  expect(tools.knowledge_search!.run(c, { query: "STaR" })).not.toContain(b);
  expect(tools.knowledge_get!.run(c, { id: b, level: "summary" })).toStartWith(`${b} was merged into ${a}`);
  expect(() => tools.knowledge_verify!.run(c, { id: b })).toThrow(`merged into ${a}`);
  // A verified item is never folded into an unverified one.
  store.run("update knowledge set status = 'verified' where id = ?", a);
  const d = add("STaR again").match(/K-\S+/)![0];
  expect(() => tools.knowledge_merge!.run(c, { keep: d, duplicates: [a], reason: "x" })).toThrow("keep");
});

test("file_search finds lines across workspace files and stays inside the workspace", async () => {
  const { store, rt } = setup({});
  await Bun.write(join(rt.workspace, "conversation", "part-001.txt"), "Ann said hi\nBob moved to OSLO\n");
  await Bun.write(join(rt.workspace, "notes.txt"), "oslo trip\n");
  const c = { store, agent: store.agent("lead")!, task: { id: "T-1" }, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages: [] } as unknown as ToolContext;
  expect(await tools.file_search!.run(c, { query: "oslo" })).toBe("conversation/part-001.txt:2: Bob moved to OSLO\nnotes.txt:1: oslo trip");
  expect(await tools.file_search!.run(c, { query: "oslo", path: "notes.txt" })).toBe("notes.txt:1: oslo trip");
  await expect(tools.file_search!.run(c, { query: "x", path: "../" })).rejects.toThrow("outside the workspace");
});

test("a steer task cannot be finished while its goal stays open with nothing pending", async () => {
  const { store, rt } = setup({});
  steer(store);
  const task = store.all<{ id: string }>("select id from tasks where kind = 'steer'")[0]!;
  expect(store.claim(task.id, "lead")).toBe(true);
  const c = { store, agent: store.agent("lead")!, task: store.task(task.id)!, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages: [] } as unknown as ToolContext;
  expect(() => tools.task_finish!.run(c, { result: "answered" })).toThrow("goal_complete");
  tools.goal_create!.run(c, { parent: "G0", description: "more work" });
  expect(tools.task_finish!.run(c, { result: "planned" })).toBe(`Finished ${task.id}`);
});

test("a model call that never answers times out instead of holding the run", async () => {
  const { rt } = setup({});
  const faux = fauxProvider();
  rt.models.setProvider(faux.provider);
  faux.setResponses(Array(10).fill(() => new Promise(() => {})));
  const started = Date.now();
  const r = await runScheduler({ ...rt, model: faux.getModel(), modelTimeoutMs: 50 });
  expect(r.status).toBe("error");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("unlimited defaults stay unlimited after the config is stored and read back", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "hyph-")), "state.sqlite"));
  store.init("p", "", defaultConfig);
  expect(store.config).toMatchObject({ maxAgents: Infinity, maxConcurrency: Infinity, maxModelCalls: Infinity, maxSteps: 16 });
  expect(store.takeModelCall()).toBe(true);
  expect(JSON.parse(store.meta("config")!).maxModelCalls).toBeNull(); // what the dashboard reads
});

test("working memory can be edited in part, and a range of steps is replaced only by a shorter note", () => {
  const { store, rt } = setup({});
  const step = (id: string, name: string, text: string): Message[] => [
    { role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }], api: "x", provider: "x", model: "x", usage: {} as never, stopReason: "toolUse", timestamp: 0 } as Message,
    { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError: false, timestamp: 0 },
  ];
  const messages: Message[] = [{ role: "user", content: "opening", timestamp: 0 }, ...step("c1", "file_read", "x".repeat(500)), ...step("c2", "shell", "y".repeat(500)), ...step("c3", "context_edit", "")];
  store.run("insert into episodes(id, agent, task, messages, status) values('e', 'lead', 'T-1', ?, 'running')", JSON.stringify(messages));
  const c = { store, agent: store.agent("lead")!, task: { id: "T-1" }, workspace: rt.workspace, contextDir: rt.contextDir, episode: "e", messages } as unknown as ToolContext;

  tools.memory_write!.run(c, { content: "plan: A\nstatus: todo" });
  tools.memory_edit!.run(c, { old: "todo", new: "done" });
  expect(store.memory("lead")).toEqual({ memory: "plan: A\nstatus: done", version: 2 });
  expect(() => tools.memory_edit!.run(c, { old: "missing", new: "x" })).toThrow("does not occur");

  expect(() => tools.context_edit!.run(c, { from: 1, to: 4, note: "z".repeat(5000) })).toThrow("must shrink");
  expect(() => tools.context_edit!.run(c, { from: 2, to: 4, note: "n" })).toThrow("must not separate");
  tools.context_edit!.run(c, { from: 1, to: 4, note: "read the file and ran the tests; both fine" });
  expect(messages.map(m => m.role)).toEqual(["user", "user", "assistant", "toolResult"]);
  expect(store.get<{ n: number }>("select count(*) n from episode_history where episode = 'e'")!.n).toBe(1);
});
