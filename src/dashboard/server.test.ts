import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, Store } from "../db.ts";

// The server runs in a directory without auth.json, so harness runs it starts exit before any model call.
async function serve(dir: string) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts"), "--dir", ".hyph", "--port", String(port)], { cwd: dir, stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  const reader = proc.stdout.getReader();
  while (!new TextDecoder().decode((await reader.read()).value).includes("dashboard:"));
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: base, "content-type": "application/json" }) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { proc, base, post };
}

test("dashboard lists sessions read-only and refuses paths it did not discover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-dash-"));
  mkdirSync(join(dir, ".hyph", "run"), { recursive: true });
  const store = new Store(join(dir, ".hyph", "run", "state.sqlite"));
  store.init("Dashboard check", "", defaultConfig);
  // Two workers on work tasks overlap in time (10-30 and 20-40); lead steers afterwards.
  for (const [, task, kind] of [["worker", "T-a", "work"], ["worker-2", "T-b", "work"], ["lead", "T-c", "steer"]] as const) store.run("insert into tasks(id, goal, kind, description, status, author, created_at) values(?, 'G0', ?, '', 'done', 'x', 0)", task, kind);
  for (const [agent, task, at, ms] of [["worker", "T-a", 20, 10], ["worker", "T-a", 30, 5], ["worker-2", "T-b", 40, 20], ["lead", "T-c", 60, 10]] as const)
    store.run("insert into usage(agent, task, input, output, cache_read, cache_write, prompt_chars, ms, at) values(?, ?, 0, 0, 0, 0, 0, ?, ?)", agent, task, ms, at);
  for (const [id, gist, source] of [["K-1", "Self-Rewarding Language Models", "https://arxiv.org/abs/2401.10020"], ["K-2", "x", "https://arxiv.org/html/2401.10020v2"], ["K-3", "other", "https://example.org"]])
    store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, '', '', ?, 'hypothesis', 'worker', 0)", id, gist, source);
  store.db.close();
  const { proc, base } = await serve(dir);
  try {
    const sessions = await (await fetch(`${base}/api/sessions`)).json() as { id: string; purpose: string }[];
    expect(sessions.map(s => [s.id, s.purpose])).toEqual([[".hyph/run", "Dashboard check"]]);
    const overview = await (await fetch(`${base}/api/overview?s=.hyph/run`)).json() as { agents: { id: string }[]; spans: { agent: string; start: number; end: number }[]; peak: object; duplicates: { key: string; items: { id: string }[] }[] };
    expect(overview.agents.map(a => a.id)).toEqual(["lead"]);
    expect(overview.spans.map(s => [s.agent, s.start, s.end])).toEqual([["worker", 10, 30], ["worker-2", 20, 40], ["lead", 50, 60]]);
    expect(overview.peak).toEqual({ agents: 2, work: 2 });
    expect(overview.duplicates.map(g => [g.key, g.items.map(k => k.id)])).toEqual([["source https://arxiv.org/abs/2401.10020", ["K-1", "K-2"]]]);
    expect((await fetch(`${base}/api/overview?s=..`)).status).toBe(404);
    expect((await fetch(`${base}/api/file?s=.hyph/run&path=../state.sqlite`)).status).toBe(400);
  } finally {
    proc.kill();
  }
});

test("runs start only from the dashboard's own origin, and their output and exit are reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-runs-"));
  const { proc, base, post } = await serve(dir);
  try {
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { origin: "http://evil.example", "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { origin: base, "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/api/runs", { name: "../x", kind: "run", purpose: "p" })).status).toBe(400);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p", calls: -1 })).status).toBe(400);

    const started = await (await post("/api/runs", { name: "first", kind: "run", purpose: "Write a file", mode: "single", calls: 5 })).json() as { dir: string; args: string[] };
    expect(started.dir).toBe(".hyph/first");
    expect(started.args).toEqual(["run", "Write a file", "--dir", ".hyph/first", "--calls", "5", "--mode", "single"]);
    let out: { exitCode: number | null; lines: string[] };
    do {
      await Bun.sleep(100);
      out = await (await fetch(`${base}/api/output?dir=.hyph/first`)).json() as typeof out;
    } while (out.exitCode === null);
    expect(out.exitCode).not.toBe(0);
    expect(out.lines.join("\n")).toContain("auth.json");

    // The state was created before the model failed, so the run can be resumed but not started again.
    expect((await post("/api/runs", { name: "first", kind: "run", purpose: "Write a file" })).status).toBe(400);
    const resumed = await post("/api/runs/resume", { session: ".hyph/first", calls: 10, allowShell: true });
    expect(((await resumed.json()) as { args: string[] }).args).toEqual(["run", "--dir", ".hyph/first", "--calls", "10", "--allow-shell"]);
    expect((await post("/api/runs/resume", { session: ".hyph/none" })).status).toBe(400);
  } finally {
    proc.kill();
  }
});

test("output of earlier runs stays readable from the session's run.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-log-"));
  mkdirSync(join(dir, ".hyph", "old"), { recursive: true });
  const store = new Store(join(dir, ".hyph", "old", "state.sqlite"));
  store.init("Old run", "", defaultConfig);
  store.db.close();
  await Bun.write(join(dir, ".hyph", "old", "run.log"), "first\nsecond\n");
  const { proc, base } = await serve(dir);
  try {
    expect(await (await fetch(`${base}/api/runlog?s=.hyph/old`)).json()).toEqual({ lines: ["first", "second"] });
  } finally {
    proc.kill();
  }
});

test("the RSI view reads the loop's state and log, and per-question evaluation sessions stay out of the session list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-rsi-"));
  for (const session of ["rsi/gen-1", "rsi/gen-1/eval/locomo/dynamic/q1"]) {
    mkdirSync(join(dir, ".hyph", session), { recursive: true });
    const store = new Store(join(dir, ".hyph", session, "state.sqlite"));
    store.init(session, "", defaultConfig);
    store.db.close();
  }
  await Bun.write(join(dir, ".hyph", "rsi", "state.json"), JSON.stringify({ settings: {}, generations: [{ gen: 0, base: null, phase: "done", accepted: true }] }));
  await Bun.write(join(dir, ".hyph", "rsi", "rsi.log"), "loop started\n");
  const { proc, base, post } = await serve(dir);
  try {
    expect(((await (await fetch(`${base}/api/sessions`)).json()) as { id: string }[]).map(s => s.id)).toEqual([".hyph/rsi/gen-1"]);
    const rsi = await (await fetch(`${base}/api/rsi`)).json() as { dir: string; pid: number | null; lines: string[]; state: { generations: unknown[] }; defaults: { calls: string } };
    expect([rsi.dir, rsi.pid, rsi.lines, rsi.state.generations.length]).toEqual([".hyph/rsi", null, ["loop started"], 1]);
    expect(rsi.defaults.calls).toBe("150");
    expect((await post("/api/rsi/start", { delta: 2 })).status).toBe(400);
    expect((await post("/api/rsi/start", { mode: "solo" })).status).toBe(400);
    expect((await post("/api/rsi/start", { purpose: " " })).status).toBe(400);
    expect((await post("/api/rsi/stop", {})).status).toBe(400);
  } finally {
    proc.kill();
  }
});

test("the RSI view totals each generation's evaluation from its per-question records", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-rsi-stats-"));
  const out = join(dir, ".hyph", "rsi", "gen-0", "eval", "locomo");
  mkdirSync(out, { recursive: true });
  await Bun.write(join(dir, ".hyph", "rsi", "state.json"), JSON.stringify({ settings: { perCategory: "1" }, generations: [{ gen: 0, base: null, phase: "evaluate" }] }));
  const usage = { calls: 3, input: 10, output: 2, cacheRead: 5, cacheWrite: 0 };
  await Bun.write(join(out, "predictions.jsonl"), `${JSON.stringify({ id: "q1", category: "temporal", outcome: "done", ms: 1000, usage })}\n`);
  await Bun.write(join(out, "judgments.jsonl"), `${JSON.stringify({ id: "q1", category: "temporal", label: "correct", score: 1, usage: { ...usage, calls: 1 } })}\n`);
  const { proc, base } = await serve(dir);
  try {
    const rsi = await (await fetch(`${base}/api/rsi`)).json() as { stats: Record<string, { eval: { expected: number; judged: number; calls: number; judgeCalls: number; byCategory: unknown } }> };
    const e = rsi.stats["0"]!.eval;
    expect([e.expected, e.judged, e.calls, e.judgeCalls, e.byCategory]).toEqual([6, 1, 3, 1, { temporal: { avg: 1, count: 1 } }]);
    const gen = await (await fetch(`${base}/api/rsi/gen?n=0`)).json() as { samples: { id: string; score: number; calls: number }[] };
    expect(gen.samples.map(s => [s.id, s.score, s.calls])).toEqual([["q1", 1, 3]]);
    expect((await fetch(`${base}/api/rsi/gen?n=7`)).status).toBe(404);
  } finally {
    proc.kill();
  }
});

test("the chat view is empty until the first message and refuses an empty one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-chat-"));
  const { proc, base, post } = await serve(dir);
  try {
    expect(await (await fetch(`${base}/api/chat`)).json()).toMatchObject({ window: 6, messages: [], memory: { knowledge: 0 } });
    expect((await post("/api/chat", { text: " " })).status).toBe(400);
    expect(existsSync(join(dir, ".hyph", "chat"))).toBe(false);
  } finally {
    proc.kill();
  }
});

test("diagnostics summarize a session's tool use and a generation's questions, and refuse unknown questions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-diag-"));
  const out = join(dir, ".hyph", "rsi", "gen-0", "eval", "locomo");
  mkdirSync(join(out, "dynamic", "q-1"), { recursive: true });
  const store = new Store(join(out, "dynamic", "q-1", "state.sqlite"));
  store.init("p", "", defaultConfig);
  store.run("insert into episodes(id, agent, task, messages, status) values('e1', 'lead', 'T1', ?, 'finished')", JSON.stringify([
    { role: "user", content: "start", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "knowledge_search", arguments: { query: "x" } }], usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 }, timestamp: 2 },
  ]));
  store.run("insert into ops(episode, call_id, result, is_error) values('e1', 'c1', 'No matches', 0)");
  store.db.close();
  await Bun.write(join(out, "judgments.jsonl"), `${JSON.stringify({ arm: "dynamic", id: "q:1", score: 0 })}\n`);
  mkdirSync(join(dir, ".hyph", "run"), { recursive: true });
  new Store(join(dir, ".hyph", "run", "state.sqlite")).init("p", "", defaultConfig);
  const { proc, base } = await serve(dir);
  try {
    const d = await (await fetch(`${base}/api/rsi/diagnostics?n=0`)).json() as { tools: { tool: string }[]; empty: unknown[]; questions: { sample: string; peak: number }[] };
    expect([d.tools.map(t => t.tool), d.empty.length, d.questions]).toEqual([["knowledge_search"], 1, [expect.objectContaining({ sample: "q-1", peak: 100 })]]);
    expect(((await (await fetch(`${base}/api/rsi/trace?n=0&sample=q-1`)).json()) as { text: string }).text).toContain('knowledge_search {"query":"x"}');
    expect((await fetch(`${base}/api/rsi/trace?n=0&sample=..%2F..%2Fx`)).status).toBe(404);
    const s = await (await fetch(`${base}/api/diagnostics?s=.hyph/run`)).json() as { episodes: number; trace: string };
    expect([s.episodes, s.trace]).toEqual([0, expect.stringContaining("# .hyph/run")]);
  } finally {
    proc.kill();
  }
});

test("deleting a session removes its whole run, but never the RSI loop's or the chat's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-del-"));
  for (const session of ["bench/single/q1", "bench/dynamic/q1", "keep", "rsi/gen-1"]) {
    mkdirSync(join(dir, ".hyph", session), { recursive: true });
    const store = new Store(join(dir, ".hyph", session, "state.sqlite"));
    store.init(session, "", defaultConfig);
    store.db.close();
  }
  const { proc, base, post } = await serve(dir);
  try {
    expect((await fetch(`${base}/api/overview?s=.hyph/bench/single/q1`)).status).toBe(200);
    expect(await (await post("/api/runs/delete", { session: ".hyph/bench/single/q1" })).json()).toEqual({ dir: ".hyph/bench" });
    expect(existsSync(join(dir, ".hyph", "bench"))).toBe(false);
    expect(((await (await fetch(`${base}/api/sessions`)).json()) as { id: string }[]).map(s => s.id)).toEqual([".hyph/keep", ".hyph/rsi/gen-1"]);
    expect((await post("/api/runs/delete", { session: ".hyph/rsi/gen-1" })).status).toBe(400);
    expect((await post("/api/runs/delete", { session: ".." })).status).toBe(400);
    expect((await post("/api/runs/delete", { session: ".hyph/keep" }, { "content-type": "application/json" })).status).toBe(403);
    expect(existsSync(join(dir, ".hyph", "keep"))).toBe(true);
  } finally {
    proc.kill();
  }
});
