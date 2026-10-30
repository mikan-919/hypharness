import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { render, safePath } from "../tools.ts";
import { openModel } from "../auth.ts";
import { history, openChat, reply, WINDOW } from "../chat.ts";
import type { Store } from "../db.ts";
import type { Llm } from "../locomo.ts";
import { DEFAULTS } from "../../scripts/rsi-defaults.ts";
import * as runs from "./runs.ts";
import index from "./index.html";

// The harness UI: views every state under the data directory and starts, resumes, and stops runs.
const { values: opts } = parseArgs({ options: { dir: { type: "string", default: ".hyph" }, port: { type: "string", default: "4321" } } });
const root = opts.dir!;
const port = Number(opts.port);
const open = new Map<string, Database>();
const rel = (path: string) => relative(".", path) || ".";

async function sessions() {
  const found: string[] = [];
  // The per-question sessions of RSI evaluations would bury the rest; their traces are summarized in the RSI view.
  for await (const f of new Bun.Glob("**/state.sqlite").scan({ cwd: root })) if (!/(^|\/)eval\/locomo\//.test(f)) found.push(rel(join(root, f, "..")));
  return found.sort();
}

// Only paths found by the scan are opened, so a query parameter cannot point the server at another file.
async function session(id: string | null | undefined) {
  if (!id || !(await sessions()).includes(id)) return undefined;
  let d = open.get(id);
  if (!d) open.set(id, d = new Database(join(id, "state.sqlite"), { readonly: true }));
  return { id, db: d };
}

const meta = (d: Database, key: string) => (d.query("select value from meta where key = ?").get(key) as { value: string } | null)?.value;
const all = (d: Database, sql: string, ...params: any[]) => d.query(sql).all(...params);

function overview(d: Database) {
  const config = JSON.parse(meta(d, "config") ?? "{}");
  return {
    purpose: meta(d, "purpose"), constraints: meta(d, "constraints"), config, modelCalls: Number(meta(d, "model_calls") ?? 0),
    totals: d.query("select count(*) calls, coalesce(sum(input),0) input, coalesce(sum(output),0) output, coalesce(sum(cache_read),0) cacheRead, coalesce(sum(cache_write),0) cacheWrite, coalesce(max(input + cache_read + cache_write),0) maxPromptTokens, coalesce(sum(ms),0) ms, min(at) firstAt, max(at) lastAt from usage").get(),
    agents: all(d, `select a.*, c.version memoryVersion, length(c.memory) memoryChars,
        (select count(*) from usage u where u.agent = a.id) calls, (select coalesce(sum(input),0) from usage u where u.agent = a.id) input,
        (select coalesce(sum(output),0) from usage u where u.agent = a.id) output, (select coalesce(sum(cache_read),0) from usage u where u.agent = a.id) cacheRead, (select coalesce(sum(cache_write),0) from usage u where u.agent = a.id) cacheWrite,
        (select coalesce(max(input + cache_read + cache_write),0) from usage u where u.agent = a.id) maxPromptTokens, (select max(at) from usage u where u.agent = a.id) lastAt,
        (select t.id from tasks t where t.claimed_by = a.id and t.status = 'claimed') currentTask,
        (select count(*) from tasks t where t.claimed_by = a.id and t.status = 'done') tasksDone
      from agents a join context c on c.agent = a.id order by a.created_at`),
    goals: all(d, "select * from goals order by created_at"),
    tasks: all(d, "select id, goal, kind, description, status, author, assignee, exclude, target, claimed_by, result, feedback, verified_by, created_at from tasks order by created_at desc limit 500"),
    knowledge: all(d, "select id, gist, source, status, author, verified_by, created_at from knowledge order by created_at desc limit 500"),
    domains: all(d, "select d.*, (select count(*) from domain_knowledge where domain = d.id) knowledge from domains d"),
    usage: all(d, "select id, agent, task, input, output, cache_read cacheRead, cache_write cacheWrite, ms, at from usage order by id desc limit 2000").reverse(),
    log: all(d, "select * from log order by id desc limit 500"),
  };
}

function agent(d: Database, id: string) {
  const memory = d.query("select memory, version from context where agent = ?").get(id);
  if (!memory) return undefined;
  const episodes = all(d, "select id, task, status, length(messages) chars from episodes where agent = ? order by rowid desc limit 50", id);
  const live = d.query("select id, messages from episodes where agent = ? and status = 'running'").get(id) as { id: string; messages: string } | null;
  return {
    memory, episodes,
    history: all(d, "select version, length(memory) chars, at from context_history where agent = ? order by version desc limit 50", id),
    live: live ? { episode: live.id, text: render(JSON.parse(live.messages) as Message[]) } : null,
  };
}

function episode(d: Database, id: string) {
  const row = d.query("select messages from episodes where id = ?").get(id) as { messages: string } | null;
  return row ? { text: render(JSON.parse(row.messages) as Message[]) } : undefined;
}

const SKIP = new Set(["node_modules", ".git"]);
function files(workspace: string, dir = workspace, out: { path: string; size: number }[] = []) {
  for (const name of readdirSync(dir)) {
    if (out.length >= 500) break;
    const full = join(dir, name), st = statSync(full);
    if (st.isDirectory()) { if (!SKIP.has(name)) files(workspace, full, out); }
    else out.push({ path: relative(workspace, full), size: st.size });
  }
  return out;
}

const FILE_LIMIT = 200_000;
async function file(workspace: string, path: string) {
  const full = safePath(workspace, path);
  if (!existsSync(full) || !statSync(full).isFile()) return undefined;
  const f = Bun.file(full);
  return { path, size: f.size, truncated: f.size > FILE_LIMIT, text: await f.slice(0, FILE_LIMIT).text() };
}

const json = (v: unknown) => v === undefined ? new Response("Not found", { status: 404 }) : Response.json(v);
const fail = (e: unknown, status = 400) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
const params = (req: Request) => new URL(req.url).searchParams;

// This server can start processes with shell access, so it accepts requests only from its own page:
// the Host header blocks DNS rebinding, and Origin plus a JSON body blocks cross-site form posts.
const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
// The front chat (src/chat.ts) keeps its log and memory in <dir>/chat; the model is opened on the first message.
const chatDir = rel(join(root, "chat"));
let chatStore: Store | undefined, chatLlm: Llm | undefined, chatQueue: Promise<unknown> = Promise.resolve();
const chatOpen = () => chatStore ??= (mkdirSync(chatDir, { recursive: true }), openChat(join(chatDir, "state.sqlite")));
function chatView() {
  if (!chatStore && !existsSync(join(chatDir, "state.sqlite"))) return { dir: chatDir, window: WINDOW, messages: [], memory: { knowledge: 0, domains: 0 } };
  const s = chatOpen();
  return { dir: chatDir, window: WINDOW, messages: history(s), memory: s.get("select (select count(*) from knowledge) knowledge, (select count(*) from domains where status = 'active') domains") };
}

function guard(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request) => {
    if (!hosts.includes(req.headers.get("host") ?? "")) return fail("Forbidden host", 403);
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      if (!origin || !hosts.includes(new URL(origin).host)) return fail("Forbidden origin", 403);
      if (!req.headers.get("content-type")?.startsWith("application/json")) return fail("Expected application/json", 415);
    }
    try { return await handler(req); } catch (e) { return fail(e); }
  };
}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

// The RSI loop (scripts/rsi.ts) keeps its state in <dir>/rsi; it may have been started here or from the command line.
const rsiDir = rel(join(root, "rsi"));
function rsiPid() {
  const pid = Number(existsSync(join(rsiDir, "pid")) ? readFileSync(join(rsiDir, "pid"), "utf8") : NaN);
  if (!Number.isSafeInteger(pid)) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}
async function rsi() {
  const tail = async (name: string, n: number) => {
    const f = Bun.file(join(rsiDir, name));
    return await f.exists() ? (await f.text()).trimEnd().split("\n").slice(-n) : [];
  };
  const file = Bun.file(join(rsiDir, "state.json"));
  const state = await file.exists() ? await file.json() as { settings: { perCategory?: string }; generations: { gen: number }[] } : null;
  // Six LoCoMo-Plus categories, perCategory questions each; the loop fixes perCategory at its first start.
  const expected = 6 * Number(state?.settings.perCategory ?? 3);
  const stats = Object.fromEntries(await Promise.all((state?.generations ?? []).map(async g =>
    [g.gen, { improver: improverTotals(genDir(g.gen)), eval: await evalTotals(genDir(g.gen), expected) }] as const)));
  return { dir: rsiDir, pid: rsiPid(), state, defaults: DEFAULTS, stats, lines: await tail("rsi.log", 300), launcher: await tail("launcher.log", 40) };
}

const genDir = (gen: number) => join(rsiDir, `gen-${gen}`);
// These files are written by the loop while the dashboard reads them, so each read opens and closes its own handle.
function withDb<T>(path: string, fn: (d: Database) => T) {
  if (!existsSync(path)) return null;
  const d = new Database(path, { readonly: true });
  try { return fn(d); } finally { d.close(); }
}
const usageTotals = "select count(*) calls, coalesce(sum(input),0) input, coalesce(sum(output),0) output, coalesce(sum(cache_read),0) cacheRead, coalesce(sum(cache_write),0) cacheWrite, coalesce(max(input + cache_read + cache_write),0) maxPromptTokens, coalesce(sum(ms),0) ms, min(at) firstAt, max(at) lastAt from usage";
const improverTotals = (dir: string) => withDb(join(dir, "state.sqlite"), d => d.query(usageTotals).get());

async function jsonl(path: string) {
  const f = Bun.file(path);
  if (!await f.exists()) return [];
  return (await f.text()).split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l) as Row]; } catch { return []; } });
}
type Row = Record<string, any>;
const sum = (rows: Row[], key: string) => rows.reduce((n, r) => n + (r.usage?.[key] ?? 0), 0);

// Read from the benchmark's per-question records, so an evaluation in progress is shown too.
async function evalTotals(dir: string, expected: number) {
  const out = join(dir, "eval", "locomo");
  const preds = await jsonl(join(out, "predictions.jsonl")), judged = await jsonl(join(out, "judgments.jsonl"));
  if (!preds.length && !judged.length) return null;
  const byCategory: Record<string, { score: number; count: number }> = {};
  for (const j of judged) { const c = byCategory[j.category] ??= { score: 0, count: 0 }; c.score += j.score; c.count++; }
  return {
    expected, predicted: preds.length, judged: judged.length, ms: preds.reduce((n, p) => n + p.ms, 0),
    calls: sum(preds, "calls"), input: sum(preds, "input"), output: sum(preds, "output"), cacheRead: sum(preds, "cacheRead"), cacheWrite: sum(preds, "cacheWrite"),
    judgeCalls: sum(judged, "calls"), judgeInput: sum(judged, "input") + sum(judged, "cacheRead") + sum(judged, "cacheWrite"),
    outcomes: preds.reduce<Record<string, number>>((o, p) => (o[p.outcome] = (o[p.outcome] ?? 0) + 1, o), {}),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([c, v]) => [c, { avg: v.score / v.count, count: v.count }])),
  };
}

// One generation in detail: the improver's calls and every evaluated question with its score and context size.
async function rsiGeneration(gen: number) {
  const dir = genDir(gen);
  if (!existsSync(dir)) return undefined;
  const out = join(dir, "eval", "locomo");
  const preds = new Map((await jsonl(join(out, "predictions.jsonl"))).map(p => [p.id, p]));
  const samples = (await jsonl(join(out, "judgments.jsonl"))).map(j => {
    const p = preds.get(j.id);
    const sizes = withDb(join(out, String(j.arm), String(j.id).replaceAll(":", "-"), "state.sqlite"),
      d => d.query("select input + cache_read + cache_write n from usage").all().map(r => (r as { n: number }).n)) ?? [];
    return {
      id: j.id, category: j.category, label: j.label, score: j.score, outcome: p?.outcome, calls: p?.usage.calls ?? 0, ms: p?.ms ?? 0,
      peakTokens: sizes.length ? Math.max(...sizes) : 0, meanTokens: sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0,
    };
  });
  const usage = withDb(join(dir, "state.sqlite"), d => d.query("select id, agent, input, output, cache_read cacheRead, cache_write cacheWrite, ms, at from usage order by id desc limit 2000").all().reverse()) ?? [];
  const agents = withDb(join(dir, "state.sqlite"), d => d.query("select id from agents order by created_at").all()) ?? [];
  return { gen, usage, agents, samples };
}

// ponytail: bound to loopback with no user auth; add authentication before exposing it beyond localhost
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  routes: {
    "/": index,
    "/api/sessions": guard(async () => Response.json(await Promise.all((await sessions()).map(async id => {
      const d = (await session(id))!.db;
      return { id, purpose: meta(d, "purpose"), mode: JSON.parse(meta(d, "config") ?? "{}").organization, modelCalls: Number(meta(d, "model_calls") ?? 0),
        rootStatus: (d.query("select status from goals where id = 'G0'").get() as { status: string } | null)?.status,
        lastAt: (d.query("select max(at) at from log").get() as { at: number | null }).at };
    })))),
    "/api/overview": guard(async req => { const s = await session(params(req).get("s")); return json(s && overview(s.db)); }),
    "/api/agent": guard(async req => { const p = params(req), s = await session(p.get("s")); return json(s && agent(s.db, p.get("id") ?? "")); }),
    "/api/episode": guard(async req => { const p = params(req), s = await session(p.get("s")); return json(s && episode(s.db, p.get("id") ?? "")); }),
    "/api/files": guard(async req => {
      const s = await session(params(req).get("s"));
      return json(s && (existsSync(join(s.id, "workspace")) ? files(join(s.id, "workspace")).sort((a, b) => a.path.localeCompare(b.path)) : []));
    }),
    "/api/file": guard(async req => { const p = params(req), s = await session(p.get("s")); return json(s && await file(join(s.id, "workspace"), p.get("path") ?? "")); }),
    "/api/runs": {
      GET: guard(() => Response.json(runs.list())),
      // Starts a new session (or a bench group) in a new directory under the data directory.
      POST: guard(async req => {
        const body = await req.json() as runs.RunRequest & { name?: string };
        if (typeof body.name !== "string" || !NAME.test(body.name)) throw new Error("name must be 1-40 lowercase letters, digits, '-' or '_'");
        return Response.json(runs.start(rel(join(root, body.name)), body, false));
      }),
    },
    "/api/runs/resume": {
      POST: guard(async req => {
        const body = await req.json() as runs.RunRequest & { session?: string };
        const s = await session(body.session) ?? (() => { throw new Error("Unknown session"); })();
        return Response.json(runs.start(s.id, { ...body, kind: "run" }, true));
      }),
    },
    "/api/runs/stop": { POST: guard(async req => Response.json(runs.stop(String((await req.json() as { dir?: string }).dir)))) },
    "/api/rsi": guard(async () => Response.json(await rsi())),
    "/api/rsi/gen": guard(async req => {
      const n = Number(params(req).get("n"));
      return json(Number.isSafeInteger(n) && n >= 0 ? await rsiGeneration(n) : undefined);
    }),
    "/api/rsi/start": { POST: guard(async req => Response.json(runs.startRsi(rsiDir, await req.json() as runs.RsiRequest))) },
    "/api/rsi/stop": {
      POST: guard(() => {
        if (runs.list().some(r => r.dir === rsiDir && r.running)) return Response.json(runs.stop(rsiDir));
        const pid = rsiPid() ?? (() => { throw new Error("The RSI loop is not running"); })();
        process.kill(pid, "SIGTERM");
        return Response.json({ pid });
      }),
    },
    "/api/chat": {
      GET: guard(() => Response.json(chatView())),
      // Replies are made one at a time: each one moves older messages into memory before the next reads it.
      POST: guard(async req => {
        const { text } = await req.json() as { text?: unknown };
        if (typeof text !== "string" || !text.trim() || text.length > 20_000) throw new Error("text must be 1-20000 characters");
        const next = chatQueue.then(async () => reply(chatLlm ??= await openModel(), chatOpen(), text.trim()));
        chatQueue = next.catch(() => {});
        return Response.json({ ...(await next), ...chatView() });
      }),
    },
    "/api/output": guard(req => json(runs.output(params(req).get("dir") ?? ""))),
    // Output of runs from before this server started, kept in the session's run.log.
    "/api/runlog": guard(async req => {
      const s = await session(params(req).get("s"));
      const log = s && Bun.file(join(s.id, "run.log"));
      return json(s && { lines: log && await log.exists() ? (await log.text()).trimEnd().split("\n").slice(-400) : [] });
    }),
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { runs.stopAll(); process.exit(0); });
console.log(`dashboard: ${server.url} (reading ${root})`);
