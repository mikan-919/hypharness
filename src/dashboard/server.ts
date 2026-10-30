import { Database } from "bun:sqlite";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import type { Message } from "@earendil-works/pi-ai";
import { render } from "../tools.ts";
import index from "./index.html";

// Read-only view over every harness state under the data directory (sessions, bench runs, smoke runs).
const { values: opts } = parseArgs({ options: { dir: { type: "string", default: ".hyph" }, port: { type: "string", default: "4321" } } });
const root = opts.dir!;
const open = new Map<string, Database>();

async function sessions() {
  const found: string[] = [];
  for await (const f of new Bun.Glob("**/state.sqlite").scan({ cwd: root })) found.push(relative(".", join(root, f, "..")) || ".");
  return found.sort();
}

// Only paths found by the scan are opened, so a query parameter cannot point the server at another file.
async function db(session: string | null) {
  if (!session || !(await sessions()).includes(session)) return undefined;
  let d = open.get(session);
  if (!d) open.set(session, d = new Database(join(session, "state.sqlite"), { readonly: true }));
  return d;
}

const meta = (d: Database, key: string) => (d.query("select value from meta where key = ?").get(key) as { value: string } | null)?.value;
const all = (d: Database, sql: string, ...params: any[]) => d.query(sql).all(...params);

function overview(d: Database) {
  const config = JSON.parse(meta(d, "config") ?? "{}");
  return {
    purpose: meta(d, "purpose"), constraints: meta(d, "constraints"), config, modelCalls: Number(meta(d, "model_calls") ?? 0),
    totals: d.query("select count(*) calls, coalesce(sum(input),0) input, coalesce(sum(output),0) output, coalesce(sum(cache_read),0) cacheRead, coalesce(sum(cache_write),0) cacheWrite, coalesce(max(prompt_chars),0) maxPromptChars, coalesce(sum(ms),0) ms, min(at) firstAt, max(at) lastAt from usage").get(),
    agents: all(d, `select a.*, c.version memoryVersion, length(c.memory) memoryChars,
        (select count(*) from usage u where u.agent = a.id) calls, (select coalesce(sum(input),0) from usage u where u.agent = a.id) input,
        (select coalesce(sum(output),0) from usage u where u.agent = a.id) output, (select coalesce(sum(cache_read),0) from usage u where u.agent = a.id) cacheRead, (select coalesce(sum(cache_write),0) from usage u where u.agent = a.id) cacheWrite,
        (select coalesce(max(prompt_chars),0) from usage u where u.agent = a.id) maxPromptChars, (select max(at) from usage u where u.agent = a.id) lastAt,
        (select t.id from tasks t where t.claimed_by = a.id and t.status = 'claimed') currentTask,
        (select count(*) from tasks t where t.claimed_by = a.id and t.status = 'done') tasksDone
      from agents a join context c on c.agent = a.id order by a.created_at`),
    goals: all(d, "select * from goals order by created_at"),
    tasks: all(d, "select id, goal, kind, description, status, author, assignee, exclude, target, claimed_by, result, feedback, verified_by, created_at from tasks order by created_at desc limit 500"),
    knowledge: all(d, "select id, gist, source, status, author, verified_by, created_at from knowledge order by created_at desc limit 500"),
    domains: all(d, "select d.*, (select count(*) from domain_knowledge where domain = d.id) knowledge from domains d"),
    usage: all(d, "select id, agent, task, input, output, cache_read cacheRead, cache_write cacheWrite, prompt_chars promptChars, ms, at from usage order by id desc limit 2000").reverse(),
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

const json = (v: unknown) => v === undefined ? new Response("Not found", { status: 404 }) : Response.json(v);
const params = (req: Request) => new URL(req.url).searchParams;

// ponytail: bound to loopback with no auth; contexts may contain secrets, so add auth before exposing it beyond localhost
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(opts.port),
  routes: {
    "/": index,
    "/api/sessions": async () => {
      const list = await Promise.all((await sessions()).map(async s => {
        const d = (await db(s))!;
        return { id: s, purpose: meta(d, "purpose"), mode: JSON.parse(meta(d, "config") ?? "{}").organization, modelCalls: Number(meta(d, "model_calls") ?? 0),
          rootStatus: (d.query("select status from goals where id = 'G0'").get() as { status: string } | null)?.status,
          lastAt: (d.query("select max(at) at from log").get() as { at: number | null }).at };
      }));
      return Response.json(list);
    },
    "/api/overview": async req => { const d = await db(params(req).get("s")); return json(d && overview(d)); },
    "/api/agent": async req => { const p = params(req), d = await db(p.get("s")); return json(d && agent(d, p.get("id") ?? "")); },
    "/api/episode": async req => { const p = params(req), d = await db(p.get("s")); return json(d && episode(d, p.get("id") ?? "")); },
  },
  development: process.env.NODE_ENV !== "production" && { hmr: true, console: true },
});

console.log(`dashboard: ${server.url} (reading ${root})`);
