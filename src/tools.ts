import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringEnum, Type, type Message, type Static, type TSchema, type Tool } from "@earendil-works/pi-ai";
import type { Agent, Goal, Store, Task } from "./db.ts";

// messages is the caller's live context for the current episode; context_edit changes it in place.
export type ToolContext = { store: Store; agent: Agent; task: Task; workspace: string; contextDir: string; episode: string; messages: Message[] };
type Def<S extends TSchema> = { description: string; parameters: S; run: (c: ToolContext, a: Static<S>) => string | Promise<string> };
const def = <S extends TSchema>(d: Def<S>) => d as Def<TSchema>;

const fail = (message: string): never => { throw new Error(message); };
const Str = (description: string) => Type.String({ description });
const Opt = <S extends TSchema>(s: S) => Type.Optional(s);

function requireGoal(store: Store, id: string) {
  return store.goal(id) ?? fail(`Unknown goal ${id}`);
}

function requireOwner(goal: Goal, agent: Agent) {
  if (goal.owner !== agent.id) fail(`Goal ${goal.id} is owned by ${goal.owner}; ask the owner or have it transferred`);
}

function requireCurrent(c: ToolContext) {
  const task = c.store.task(c.task.id)!;
  if (task.status !== "claimed" || task.claimed_by !== c.agent.id) fail(`Task ${task.id} is no longer claimed by you`);
  return task;
}

function requireSteward(store: Store, id: string, agent: Agent) {
  const domain = store.get<{ id: string; steward: string; status: string }>("select * from domains where id = ?", id) ?? fail(`Unknown domain ${id}`);
  if (domain.status !== "active") fail(`Domain ${id} is ${domain.status}`);
  if (domain.steward !== agent.id) fail(`Domain ${id} is stewarded by ${domain.steward}`);
  return domain;
}

function dynamicOnly(store: Store) {
  if (store.config.organization !== "dynamic") fail(`Agent composition is fixed in ${store.config.organization} mode`);
}

// The verifier is always a different agent, except in single-agent mode where it is recorded as self-verification.
export function requestVerification(store: Store, goal: string, author: string, target: string, description: string) {
  return store.addTask({ goal, kind: "verify", author, exclude: store.config.maxAgents > 1 ? author : null, target, description });
}

function applyVerdict(store: Store, verifier: string, target: string, pass: boolean, reason: string) {
  if (target.startsWith("T-")) {
    if (pass) store.run("update tasks set status = 'done', verified_by = ?, rev = rev + 1 where id = ? and status = 'review'", verifier, target);
    else store.run("update tasks set status = 'open', claimed_by = null, lease_until = null, feedback = ?, rev = rev + 1 where id = ? and status = 'review'", reason, target);
  } else if (target.startsWith("G")) {
    if (pass) store.run("update goals set status = 'done', verified_by = ?, rev = rev + 1 where id = ? and status = 'review'", verifier, target);
    else store.run("update goals set status = 'open', feedback = ?, rev = rev + 1 where id = ? and status = 'review'", reason, target);
  } else {
    store.run("update knowledge set status = ?, verified_by = ? where id = ? and status = 'hypothesis'", pass ? "verified" : "rejected", verifier, target);
  }
}

// Resolves a workspace path and rejects anything that escapes it, including through symlinks.
export function safePath(workspace: string, path: string) {
  const root = realpathSync(workspace);
  const full = resolve(root, path);
  let probe = full;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  for (const p of [full, real]) if (p !== root && !p.startsWith(root + sep)) fail(`Path ${path} is outside the workspace`);
  return full;
}

const line = (t: Task) => `${t.id} [${t.kind}/${t.status}] goal=${t.goal}${t.assignee ? ` assignee=${t.assignee}` : ""}${t.claimed_by ? ` by=${t.claimed_by}` : ""}: ${t.description.slice(0, 160)}`;

export const tools: Record<string, Def<TSchema>> = {
  // --- CLM: own persistent context ---
  memory_write: def({
    description: "Replace your own working memory (persists across tasks and restarts; earlier versions remain restorable). Keep it compact: decisions, open questions, pointers to knowledge IDs and files.",
    parameters: Type.Object({ content: Str("The full new working memory") }),
    run(c, a) {
      const limit = c.store.config.memoryLimit;
      if (a.content.length > limit) fail(`Working memory is limited to ${limit} characters (got ${a.content.length}); compact it and move details into knowledge_add`);
      const version = c.store.writeMemory(c.agent.id, a.content);
      mirror(c, c.agent.id);
      return `Saved working memory version ${version}`;
    },
  }),
  context_read: def({
    description: "Read part of an agent's context (yours or another's, read-only): its working memory (optionally an earlier version) or its live context for the task it is working on.",
    parameters: Type.Object({ agent: Opt(Str("Agent ID; defaults to you")), part: StringEnum(["memory", "live"]), version: Opt(Type.Integer()), offset: Opt(Type.Integer({ minimum: 0 })), limit: Opt(Type.Integer({ minimum: 1, maximum: 4000 })) }),
    run(c, a) {
      const agent = a.agent ?? c.agent.id;
      const current = c.store.memory(agent) ?? fail(`Unknown agent ${agent}`);
      let text: string;
      if (a.part === "live") {
        const live = agent === c.agent.id ? c.messages : liveMessages(c.store, agent);
        text = live ? render(live) : "(no live task)";
      } else {
        text = a.version === undefined || a.version === current.version ? current.memory
          : c.store.get<{ memory: string }>("select memory from context_history where agent = ? and version = ?", agent, a.version)?.memory ?? fail(`No version ${a.version}`);
      }
      const offset = a.offset ?? 0, limit = a.limit ?? 2000;
      return `${agent} ${a.part} chars ${offset}-${Math.min(offset + limit, text.length)} of ${text.length}:\n${text.slice(offset, offset + limit)}`;
    },
  }),
  context_outline: def({
    description: "List the messages of your live context with index, role, and size, to decide what to compact.",
    parameters: Type.Object({}),
    run(c) {
      return c.messages.map((m, i) => `#${i} ${m.role} ${JSON.stringify(m.content).length} chars: ${render([m]).replace(/^#\d+ \w+: /, "").slice(0, 80).replace(/\n/g, " ")}`).join("\n");
    },
  }),
  context_edit: def({
    description: "Replace messages #from..#to of your live context with a short note (for example, a large tool output you have already digested). Takes effect from your next step; the originals are kept in history. Editing older messages invalidates more of the prompt cache, so prefer compacting recent bulky messages.",
    parameters: Type.Object({ from: Type.Integer({ minimum: 1 }), to: Type.Integer({ minimum: 1 }), note: Str("What the replaced messages established, with IDs and paths needed later") }),
    run(c, a) {
      const m = c.messages;
      const lastAssistant = m.findLastIndex(x => x.role === "assistant");
      if (a.from > a.to || a.to >= lastAssistant) fail(`Range must be within #1..#${lastAssistant - 1}`);
      if (m[a.from]!.role === "toolResult" || m[a.to + 1]?.role === "toolResult") fail("The range must not separate a tool call from its result; include whole steps");
      c.store.run("insert into episode_history(episode, at, messages) values(?, ?, ?)", c.episode, Date.now(), JSON.stringify(m));
      m.splice(a.from, a.to - a.from + 1, { role: "user", content: `[context note replacing #${a.from}-#${a.to}] ${a.note}`, timestamp: Date.now() });
      c.store.run("update episodes set messages = ? where id = ?", JSON.stringify(m), c.episode);
      return `Replaced #${a.from}-#${a.to}; live context now has ${m.length} messages`;
    },
  }),
  news: def({
    description: "Show what other agents did since you last checked (published knowledge, finished or released tasks, verdicts, organization changes). Gists only.",
    parameters: Type.Object({}),
    run(c) {
      const key = `cursor:${c.agent.id}`;
      const rows = c.store.all<{ id: number; agent: string; event: string; detail: string }>("select * from log where id > ? and (agent is null or agent != ?) order by id limit 40", Number(c.store.meta(key) ?? 0), c.agent.id);
      if (rows.length) c.store.setMeta(key, String(rows.at(-1)!.id));
      return rows.map(r => `${r.agent ?? "host"} ${r.event} ${r.detail.slice(0, 200)}`).join("\n") || "Nothing new";
    },
  }),
  memory_restore: def({
    description: "Restore an earlier version of your own working memory (the current one is kept in history).",
    parameters: Type.Object({ version: Type.Integer() }),
    run(c, a) {
      const old = c.store.get<{ memory: string }>("select memory from context_history where agent = ? and version = ?", c.agent.id, a.version) ?? fail(`No version ${a.version}`);
      const version = c.store.writeMemory(c.agent.id, old.memory);
      mirror(c, c.agent.id);
      return `Restored version ${a.version} as version ${version}`;
    },
  }),

  // --- DeLM: goals ---
  goal_list: def({
    description: "List goals as a tree with owner and status.",
    parameters: Type.Object({}),
    run(c) {
      return c.store.all<Goal>("select * from goals order by created_at").map(g =>
        `${g.id} rev=${g.rev} parent=${g.parent ?? "-"} [${g.status}] owner=${g.owner}: ${g.description.slice(0, 200)}${g.feedback ? ` (last rejection: ${g.feedback.slice(0, 200)})` : ""}`).join("\n");
    },
  }),
  goal_create: def({
    description: "Create a subgoal under an existing goal. You become its owner.",
    parameters: Type.Object({ parent: Str("Parent goal ID"), description: Str("What must be true when this goal is achieved") }),
    run(c, a) {
      const parent = requireGoal(c.store, a.parent);
      if (parent.status !== "open") fail(`Goal ${parent.id} is ${parent.status}`);
      const id = c.store.id("G");
      c.store.run("insert into goals(id, parent, description, status, owner, created_at) values(?, ?, ?, 'open', ?, ?)", id, a.parent, a.description, c.agent.id, Date.now());
      c.store.log(c.agent.id, "goal_created", { id, parent: a.parent });
      return `Created goal ${id}`;
    },
  }),
  goal_update: def({
    description: "Refine the description of a goal you own, or drop it (its open tasks fail). The top-level goal G0 cannot be changed.",
    parameters: Type.Object({ id: Str("Goal ID"), rev: Type.Integer({ description: "Revision from goal_list" }), description: Opt(Type.String()), drop: Opt(Type.Boolean()) }),
    run(c, a) {
      const goal = requireGoal(c.store, a.id);
      if (goal.id === "G0") fail("The top-level goal is fixed");
      requireOwner(goal, c.agent);
      if (goal.status !== "open") fail(`Goal ${goal.id} is ${goal.status}`);
      c.store.tx(() => {
        if (c.store.run("update goals set description = ?, status = ?, rev = rev + 1 where id = ? and rev = ?", a.description ?? goal.description, a.drop ? "dropped" : "open", goal.id, a.rev) !== 1) fail(`Revision conflict: goal is at rev ${goal.rev}; re-read it with goal_list`);
        if (a.drop) c.store.run("update tasks set status = 'failed', feedback = 'goal dropped' where goal = ? and status = 'open'", goal.id);
        c.store.log(c.agent.id, a.drop ? "goal_dropped" : "goal_refined", { id: goal.id, description: a.description });
      });
      return `Updated goal ${goal.id} (rev ${goal.rev + 1})`;
    },
  }),
  goal_transfer: def({
    description: "Transfer ownership of a goal you own to another agent.",
    parameters: Type.Object({ id: Str("Goal ID"), to: Str("Agent ID") }),
    run(c, a) {
      const goal = requireGoal(c.store, a.id);
      requireOwner(goal, c.agent);
      if (goal.id === "G0") fail("The top-level goal stays with lead");
      c.store.agent(a.to) ?? fail(`Unknown agent ${a.to}`);
      c.store.run("update goals set owner = ?, rev = rev + 1 where id = ? and owner = ?", a.to, a.id, c.agent.id);
      c.store.log(c.agent.id, "goal_transferred", { id: a.id, to: a.to });
      return `Goal ${a.id} now owned by ${a.to}`;
    },
  }),
  goal_complete: def({
    description: "Submit a goal you own as achieved. Requires all its subgoals closed and no other pending tasks. An independent agent verifies the deliverable before it counts as done.",
    parameters: Type.Object({ id: Str("Goal ID"), deliverable: Str("What was produced (file paths, knowledge IDs) and how it satisfies the goal") }),
    run(c, a) {
      const goal = requireGoal(c.store, a.id);
      requireOwner(goal, c.agent);
      if (goal.status !== "open") fail(`Goal ${goal.id} is ${goal.status}`);
      const subgoals = c.store.all<Goal>("select * from goals where parent = ? and status in ('open', 'review')", goal.id);
      if (subgoals.length) fail(`Open subgoals: ${subgoals.map(g => g.id).join(", ")}`);
      const pending = c.store.all<Task>("select * from tasks where goal = ? and status in ('open', 'claimed', 'review') and id != ?", goal.id, c.task.id);
      if (pending.length) fail(`Pending tasks: ${pending.map(t => t.id).join(", ")}`);
      c.store.tx(() => {
        c.store.run("update goals set status = 'review', deliverable = ?, rev = rev + 1 where id = ?", a.deliverable, goal.id);
        requestVerification(c.store, goal.id, c.agent.id, goal.id, `Verify that goal ${goal.id} is achieved.\nGoal: ${goal.description}\nClaimed deliverable: ${a.deliverable}\nInspect the actual artifacts; do not trust the claim.`);
      });
      return `Goal ${goal.id} submitted for verification`;
    },
  }),

  // --- DeLM: tasks ---
  task_list: def({
    description: "List tasks, optionally filtered by goal and status.",
    parameters: Type.Object({ goal: Opt(Type.String()), status: Opt(StringEnum(["open", "claimed", "review", "done", "failed"])) }),
    run(c, a) {
      const rows = c.store.all<Task>("select * from tasks where (?1 is null or goal = ?1) and (?2 is null or status = ?2) order by created_at desc limit 40", a.goal ?? null, a.status ?? null);
      return rows.map(line).join("\n") || "No tasks";
    },
  }),
  task_get: def({
    description: "Read a task with its result and feedback.",
    parameters: Type.Object({ id: Str("Task ID") }),
    run(c, a) {
      const t = c.store.task(a.id) ?? fail(`Unknown task ${a.id}`);
      return `${line(t)}\nresult: ${t.result ?? "-"}\nfeedback: ${t.feedback ?? "-"}\nverified_by: ${t.verified_by ?? "-"}`;
    },
  }),
  task_create: def({
    description: "Create a work task under an open goal. Optionally assign it to a specific agent; otherwise any agent may claim it.",
    parameters: Type.Object({ goal: Str("Goal ID"), description: Str("Self-contained description: what to do and how success is checked"), assignee: Opt(Type.String()) }),
    run(c, a) {
      const goal = requireGoal(c.store, a.goal);
      if (goal.status !== "open") fail(`Goal ${goal.id} is ${goal.status}`);
      if (a.assignee) c.store.agent(a.assignee) ?? fail(`Unknown agent ${a.assignee}`);
      const id = c.store.addTask({ goal: a.goal, kind: "work", description: a.description, author: c.agent.id, assignee: a.assignee });
      c.store.log(c.agent.id, "task_created", { id, goal: a.goal, assignee: a.assignee, description: a.description.slice(0, 160) });
      return `Created task ${id}`;
    },
  }),
  task_assign: def({
    description: "Reassign an open task you authored to another agent (or null for anyone).",
    parameters: Type.Object({ id: Str("Task ID"), to: Type.Union([Type.String(), Type.Null()]) }),
    run(c, a) {
      const t = c.store.task(a.id) ?? fail(`Unknown task ${a.id}`);
      if (t.author !== c.agent.id) fail(`Task ${t.id} was authored by ${t.author}`);
      if (a.to) c.store.agent(a.to) ?? fail(`Unknown agent ${a.to}`);
      if (c.store.run("update tasks set assignee = ?, rev = rev + 1 where id = ? and status = 'open'", a.to, a.id) !== 1) fail(`Task ${a.id} is not open`);
      if (a.to) c.store.run("update agents set status = 'active', idle = 0 where id = ?", a.to);
      return `Task ${a.id} assigned to ${a.to ?? "anyone"}`;
    },
  }),
  task_finish: def({
    description: "Finish your current task. For work tasks, describe the result and where the artifacts are; an independent agent will verify it. For verify tasks, give verdict pass or fail with the evidence you checked.",
    parameters: Type.Object({ result: Str("Result, artifact paths, and evidence"), verdict: Opt(StringEnum(["pass", "fail"])) }),
    run(c, a) {
      const task = requireCurrent(c);
      c.store.tx(() => {
        if (task.kind === "verify") {
          if (!a.verdict) fail("Verify tasks need a verdict");
          applyVerdict(c.store, c.agent.id, task.target!, a.verdict === "pass", a.result);
          c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", `${a.verdict}: ${a.result}`, task.id);
          c.store.log(c.agent.id, "verified", { target: task.target, verdict: a.verdict, self: task.author === c.agent.id });
        } else if (task.kind === "work") {
          c.store.run("update tasks set status = 'review', result = ?, rev = rev + 1 where id = ?", a.result, task.id);
          requestVerification(c.store, task.goal, c.agent.id, task.id, `Verify task ${task.id}.\nTask: ${task.description}\nClaimed result: ${a.result}\nInspect the actual artifacts; do not trust the claim.`);
        } else {
          // A steer task exists because its goal had nothing pending; finishing it without a decision would only recreate it.
          const goal = c.store.goal(task.goal)!;
          const pending = c.store.get("select 1 from goals where parent = ?1 and status in ('open', 'review') union all select 1 from tasks where goal = ?1 and status in ('open', 'claimed', 'review') and id != ?2", goal.id, task.id);
          if (goal.status === "open" && !pending) fail(`Goal ${goal.id} is still open with nothing pending. Submit it with goal_complete, create tasks or subgoals, refine or drop it with goal_update, or task_release if you need more time.`);
          c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", a.result, task.id);
        }
      });
      c.store.log(c.agent.id, "task_finished", { id: task.id, kind: task.kind, verdict: a.verdict, result: a.result.slice(0, 160) });
      return `Finished ${task.id}`;
    },
  }),
  task_release: def({
    description: "Give your current task back unfinished, with a note for whoever picks it up next.",
    parameters: Type.Object({ note: Str("What was done and what remains") }),
    run(c, a) {
      const task = requireCurrent(c);
      c.store.run("update tasks set status = 'open', claimed_by = null, lease_until = null, feedback = ?, rev = rev + 1 where id = ?", a.note, task.id);
      c.store.log(c.agent.id, "task_released", { id: task.id, note: a.note.slice(0, 160) });
      return `Released ${task.id}`;
    },
  }),

  // --- DeLM: knowledge (Gist -> Summary -> Raw) ---
  knowledge_add: def({
    description: "Record knowledge with its source. It starts as an unverified hypothesis. Gist is one line, summary a paragraph, raw the original evidence (excerpt, output, data).",
    parameters: Type.Object({ gist: Str("One-line core claim"), summary: Str("Short explanation"), raw: Str("Original evidence"), source: Str("Where it came from: file path, URL, command, or 'inference from K-...'"), domain: Opt(Str("Domain ID to link it to (you must steward it)")) }),
    run(c, a) {
      const id = c.store.id("K");
      c.store.tx(() => {
        if (a.domain) requireSteward(c.store, a.domain, c.agent);
        c.store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, ?, ?, ?, 'hypothesis', ?, ?)", id, a.gist, a.summary, a.raw, a.source, c.agent.id, Date.now());
        if (a.domain) c.store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", a.domain, id);
      });
      c.store.log(c.agent.id, "knowledge_added", { id, gist: a.gist });
      return `Recorded ${id} as hypothesis; use knowledge_verify to have it checked`;
    },
  }),
  knowledge_search: def({
    description: "Search knowledge; returns gists only. Expand with knowledge_get.",
    parameters: Type.Object({ query: Str("Words to match"), domain: Opt(Type.String()), status: Opt(StringEnum(["hypothesis", "verified", "rejected"])) }),
    run(c, a) {
      const words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
      const rows = c.store.all<{ id: string; gist: string; summary: string; status: string }>(
        "select k.* from knowledge k where (?1 is null or k.id in (select knowledge from domain_knowledge where domain = ?1)) and (?2 is null or k.status = ?2)",
        a.domain ?? null, a.status ?? null);
      // ponytail: linear scan with word counting; switch to SQLite FTS5 when knowledge grows past a few thousand rows
      return rows.map(k => ({ k, score: words.filter(w => `${k.gist} ${k.summary}`.toLowerCase().includes(w)).length }))
        .filter(r => r.score > 0 || !words.length).sort((x, y) => y.score - x.score).slice(0, 12)
        .map(({ k }) => `${k.id} [${k.status}] ${k.gist}`).join("\n") || "No matches";
    },
  }),
  knowledge_get: def({
    description: "Expand a knowledge item to its summary, or to raw evidence when you need the basis.",
    parameters: Type.Object({ id: Str("Knowledge ID"), level: StringEnum(["summary", "raw"]) }),
    run(c, a) {
      const k = c.store.get<Record<string, string>>("select * from knowledge where id = ?", a.id) ?? fail(`Unknown knowledge ${a.id}`);
      const domains = c.store.all<{ domain: string }>("select domain from domain_knowledge where knowledge = ?", a.id).map(d => d.domain);
      return `${k.id} [${k.status}${k.verified_by ? ` by ${k.verified_by}` : ""}] source=${k.source} domains=${domains.join(",") || "-"}\ngist: ${k.gist}\nsummary: ${k.summary}${a.level === "raw" ? `\nraw: ${k.raw}` : ""}`;
    },
  }),
  knowledge_verify: def({
    description: "Request independent verification of a hypothesis.",
    parameters: Type.Object({ id: Str("Knowledge ID") }),
    run(c, a) {
      const k = c.store.get<Record<string, string>>("select * from knowledge where id = ?", a.id) ?? fail(`Unknown knowledge ${a.id}`);
      if (k.status !== "hypothesis") fail(`${a.id} is already ${k.status}`);
      if (c.store.get("select id from tasks where target = ? and status in ('open', 'claimed')", a.id)) fail(`Verification of ${a.id} is already pending`);
      const id = requestVerification(c.store, c.task.goal, k.author!, a.id, `Verify knowledge ${a.id} against its source.\ngist: ${k.gist}\nsummary: ${k.summary}\nsource: ${k.source}\nCheck the raw evidence (knowledge_get level=raw) and the source itself.`);
      return `Created verification task ${id}`;
    },
  }),

  // --- DeLM: domains (responsibility over references to knowledge) ---
  domain_list: def({
    description: "List knowledge domains with steward, status, and knowledge counts.",
    parameters: Type.Object({}),
    run(c) {
      return c.store.all<Record<string, string | number>>("select d.*, (select count(*) from domain_knowledge where domain = d.id) n from domains d").map(d =>
        `${d.id} [${d.status}] steward=${d.steward} parent=${d.parent ?? "-"} n=${d.n}: ${d.name} — ${d.description}`).join("\n") || "No domains";
    },
  }),
  domain_create: def({
    description: "Create a domain of responsibility. You become its steward.",
    parameters: Type.Object({ name: Type.String(), description: Type.String() }),
    run(c, a) {
      const id = c.store.id("D");
      c.store.run("insert into domains(id, name, description, steward, status) values(?, ?, ?, ?, 'active')", id, a.name, a.description, c.agent.id);
      c.store.log(c.agent.id, "domain_created", { id, name: a.name });
      return `Created domain ${id}`;
    },
  }),
  domain_link: def({
    description: "Link existing knowledge to a domain you steward. Knowledge is referenced, never copied, and may belong to several domains.",
    parameters: Type.Object({ domain: Type.String(), knowledge: Type.Array(Type.String(), { minItems: 1 }) }),
    run(c, a) {
      c.store.tx(() => {
        requireSteward(c.store, a.domain, c.agent);
        for (const k of a.knowledge) {
          c.store.get("select id from knowledge where id = ?", k) ?? fail(`Unknown knowledge ${k}`);
          c.store.run("insert or ignore into domain_knowledge(domain, knowledge) values(?, ?)", a.domain, k);
        }
      });
      return `Linked ${a.knowledge.length} items to ${a.domain}`;
    },
  }),
  domain_split: def({
    description: "Split a domain you steward into subdomains, each taking some of its knowledge references. The original is retired but keeps its links as history.",
    parameters: Type.Object({ id: Type.String(), parts: Type.Array(Type.Object({ name: Type.String(), description: Type.String(), steward: Opt(Type.String()), knowledge: Type.Array(Type.String()) }), { minItems: 2 }) }),
    run(c, a) {
      const ids = c.store.tx(() => {
        requireSteward(c.store, a.id, c.agent);
        const linked = new Set(c.store.all<{ knowledge: string }>("select knowledge from domain_knowledge where domain = ?", a.id).map(r => r.knowledge));
        const created = a.parts.map(p => {
          if (p.steward) c.store.agent(p.steward) ?? fail(`Unknown agent ${p.steward}`);
          const id = c.store.id("D");
          c.store.run("insert into domains(id, name, description, steward, parent, status) values(?, ?, ?, ?, ?, 'active')", id, p.name, p.description, p.steward ?? c.agent.id, a.id);
          for (const k of p.knowledge) {
            if (!linked.has(k)) fail(`${k} is not linked to ${a.id}`);
            c.store.run("insert or ignore into domain_knowledge(domain, knowledge) values(?, ?)", id, k);
          }
          return id;
        });
        c.store.run("update domains set status = 'split', rev = rev + 1 where id = ?", a.id);
        c.store.log(c.agent.id, "domain_split", { id: a.id, into: created });
        return created;
      });
      return `Split ${a.id} into ${ids.join(", ")}`;
    },
  }),
  domain_merge: def({
    description: "Merge domains you steward into a new domain holding all their knowledge references. The originals are retired.",
    parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 2 }), name: Type.String(), description: Type.String() }),
    run(c, a) {
      const id = c.store.tx(() => {
        for (const d of a.ids) requireSteward(c.store, d, c.agent);
        const id = c.store.id("D");
        c.store.run("insert into domains(id, name, description, steward, status) values(?, ?, ?, ?, 'active')", id, a.name, a.description, c.agent.id);
        for (const d of a.ids) {
          c.store.run("insert or ignore into domain_knowledge(domain, knowledge) select ?, knowledge from domain_knowledge where domain = ?", id, d);
          c.store.run("update domains set status = 'merged', parent = ?, rev = rev + 1 where id = ?", id, d);
        }
        c.store.log(c.agent.id, "domain_merged", { ids: a.ids, into: id });
        return id;
      });
      return `Merged into ${id}`;
    },
  }),
  domain_transfer: def({
    description: "Hand stewardship of a domain you steward to another agent.",
    parameters: Type.Object({ id: Type.String(), to: Type.String() }),
    run(c, a) {
      requireSteward(c.store, a.id, c.agent);
      c.store.agent(a.to) ?? fail(`Unknown agent ${a.to}`);
      c.store.run("update domains set steward = ?, rev = rev + 1 where id = ? and steward = ?", a.to, a.id, c.agent.id);
      c.store.log(c.agent.id, "domain_transferred", { id: a.id, to: a.to });
      return `Domain ${a.id} now stewarded by ${a.to}`;
    },
  }),

  // --- DeLM: organization ---
  agent_list: def({
    description: "List agents with role, status, and current load.",
    parameters: Type.Object({}),
    run(c) {
      return c.store.agents().map(g => {
        const load = c.store.get<{ n: number }>("select count(*) n from tasks where (claimed_by = ?1 and status = 'claimed') or (assignee = ?1 and status = 'open')", g.id)!.n;
        return `${g.id} [${g.status}] load=${load} parent=${g.parent ?? "-"}: ${g.role}`;
      }).join("\n");
    },
  }),
  agent_spawn: def({
    description: "Create a new agent with its own persistent context. Only when existing or dormant agents cannot be reused and the expected benefit exceeds the cost of another agent.",
    parameters: Type.Object({ id: Type.String({ pattern: "^[a-z][a-z0-9-]{1,30}$" }), role: Str("Responsibility and expertise"), reason: Str("Why no existing agent can do this") }),
    run(c, a) {
      dynamicOnly(c.store);
      return c.store.tx(() => {
        const n = c.store.get<{ n: number }>("select count(*) n from agents")!.n;
        if (n >= c.store.config.maxAgents) fail(`Agent limit ${c.store.config.maxAgents} reached; reuse a dormant agent with task_assign`);
        if (c.store.agent(a.id)) fail(`Agent ${a.id} exists`);
        c.store.addAgent(a.id, a.role, c.agent.id);
        c.store.log(c.agent.id, "agent_spawn_reason", { id: a.id, reason: a.reason });
        return `Spawned ${a.id}; give it work with task_create assignee=${a.id}`;
      });
    },
  }),
  agent_sleep: def({
    description: "Put an agent you created (or yourself) to sleep when it is no longer useful. Its context is kept; assigning it a task wakes it.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String() }),
    run(c, a) {
      dynamicOnly(c.store);
      const target = c.store.agent(a.id) ?? fail(`Unknown agent ${a.id}`);
      if (target.id === "lead") fail("lead cannot sleep");
      if (target.id !== c.agent.id && target.parent !== c.agent.id) fail(`Only ${target.parent} or ${target.id} can put it to sleep`);
      c.store.tx(() => {
        if (c.store.get("select id from tasks where (claimed_by = ?1 and status = 'claimed' and id != ?2) or (assignee = ?1 and status = 'open')", a.id, c.task.id)) fail(`${a.id} still has tasks; reassign them first`);
        c.store.run("update agents set status = 'dormant' where id = ?", a.id);
        c.store.log(c.agent.id, "agent_dormant", { id: a.id, reason: a.reason });
      });
      return `${a.id} is dormant`;
    },
  }),

  // --- External information ---
  web_search: def({
    description: "Search the web with Parallel. Returns ranked URLs with excerpts. Record what you rely on with knowledge_add, citing the URL as source.",
    parameters: Type.Object({
      objective: Str("Self-contained statement of what you are looking for and why"),
      queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "2-3 keyword queries of 3-6 words each" }),
      mode: Opt(StringEnum(["turbo", "fast", "basic", "advanced"], { description: "Speed versus quality; defaults to basic" })),
      max_results: Opt(Type.Integer({ minimum: 1, maximum: 20 })),
      include_domains: Opt(Type.Array(Type.String(), { description: "Restrict to these domains, e.g. docs.python.org or .gov" })),
      after_date: Opt(Str("Only content published on or after YYYY-MM-DD")),
    }),
    async run(c, a) {
      // Configuring the key is the host's permission to send queries to Parallel.
      const key = process.env.PARALLEL_API_KEY;
      if (!key) fail("Web search is not configured by the host (PARALLEL_API_KEY is not set)");
      const source = a.include_domains || a.after_date ? { include_domains: a.include_domains, after_date: a.after_date } : undefined;
      const res = await fetch("https://api.parallel.ai/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key! },
        body: JSON.stringify({
          objective: a.objective, search_queries: a.queries, mode: a.mode ?? "basic", session_id: c.task.id,
          max_chars_total: c.store.config.toolOutputLimit,
          advanced_settings: { max_results: a.max_results ?? 8, ...(source && { source_policy: source }) },
        }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await res.json() as {
        results?: { url: string; title: string | null; publish_date: string | null; excerpts?: string[] }[];
        warnings?: { message: string }[] | null; error?: { message: string };
      };
      if (!res.ok) fail(`Parallel search failed (${res.status}): ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
      const warnings = body.warnings?.map(w => `warning: ${w.message}`) ?? [];
      const results = (body.results ?? []).map((r, i) =>
        `[${i + 1}] ${r.title ?? "(untitled)"}${r.publish_date ? ` (${r.publish_date})` : ""}\n${r.url}\n${(r.excerpts ?? []).join("\n…\n")}`);
      return [...warnings, ...results].join("\n\n") || "No results";
    },
  }),

  // --- Work in the workspace ---
  file_list: def({
    description: "List files under a workspace directory.",
    parameters: Type.Object({ path: Opt(Type.String()) }),
    run(c, a) {
      const dir = safePath(c.workspace, a.path ?? ".");
      if (!existsSync(dir)) return "Directory does not exist";
      return readdirSync(dir, { recursive: true }).map(String).slice(0, 200)
        .map(f => `${relative(c.workspace, join(dir, f))}${statSync(join(dir, f)).isDirectory() ? "/" : ""}`).join("\n") || "Empty";
    },
  }),
  file_read: def({
    description: "Read part of a workspace file.",
    parameters: Type.Object({ path: Type.String(), offset: Opt(Type.Integer({ minimum: 0 })), limit: Opt(Type.Integer({ minimum: 1, maximum: 4000 })) }),
    async run(c, a) {
      const text = await Bun.file(safePath(c.workspace, a.path)).text();
      const offset = a.offset ?? 0, limit = a.limit ?? 3000;
      return `${a.path} chars ${offset}-${Math.min(offset + limit, text.length)} of ${text.length}:\n${text.slice(offset, offset + limit)}`;
    },
  }),
  file_search: def({
    description: "Find lines containing a text (case-insensitive) in workspace files, with file and line number. Use it to locate what to read instead of reading everything.",
    parameters: Type.Object({ query: Type.String({ minLength: 1 }), path: Opt(Str("Directory or file to search; defaults to the whole workspace")) }),
    async run(c, a) {
      const start = safePath(c.workspace, a.path ?? ".");
      if (!existsSync(start)) fail(`${a.path} does not exist`);
      const paths = statSync(start).isDirectory() ? readdirSync(start, { recursive: true }).map(f => join(start, String(f))).filter(f => statSync(f).isFile()) : [start];
      const needle = a.query.toLowerCase(), hits: string[] = [];
      for (const path of paths.sort()) {
        const lines = (await Bun.file(path).text()).split("\n");
        lines.forEach((l, i) => { if (hits.length < 40 && l.toLowerCase().includes(needle)) hits.push(`${relative(c.workspace, path)}:${i + 1}: ${l.slice(0, 200)}`); });
        if (hits.length >= 40) break;
      }
      return hits.join("\n") || "No matches";
    },
  }),
  file_write: def({
    description: "Write a workspace file (creates directories).",
    parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    async run(c, a) {
      const path = safePath(c.workspace, a.path);
      mkdirSync(dirname(path), { recursive: true });
      await Bun.write(path, a.content);
      return `Wrote ${a.content.length} chars to ${a.path}`;
    },
  }),
  shell: def({
    description: "Run a shell command in the workspace (60 s timeout). Requires host permission (--allow-shell).",
    parameters: Type.Object({ command: Type.String() }),
    async run(c, a) {
      if (!c.store.config.allowShell) fail("Shell is not permitted by the host; start the harness with --allow-shell to grant it");
      const proc = Bun.spawn(["sh", "-c", a.command], { cwd: c.workspace, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return `exit ${code}\n${out}${err ? `\nstderr:\n${err}` : ""}`;
    },
  }),
};

// Tools that need host configuration are left out of the model's tool list when it is missing.
export function toolSchemas(): Tool[] {
  return Object.entries(tools)
    .filter(([name]) => name !== "web_search" || process.env.PARALLEL_API_KEY)
    .map(([name, t]) => ({ name, description: t.description, parameters: t.parameters }));
}

export function liveMessages(store: Store, agent: string) {
  const row = store.get<{ messages: string }>("select messages from episodes where agent = ? and status = 'running'", agent);
  return row ? JSON.parse(row.messages) as Message[] : undefined;
}

export function render(messages: Message[]) {
  const body = (m: Message) => {
    if (m.role === "user" || m.role === "system") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    if (m.role === "toolResult") return `${m.toolName}${m.isError ? " (error)" : ""} -> ${m.content.map(b => b.type === "text" ? b.text : `[${b.type}]`).join("")}`;
    return m.content.map(b => b.type === "text" ? b.text : b.type === "toolCall" ? `call ${b.name} ${JSON.stringify(b.arguments)}` : "").filter(Boolean).join("\n");
  };
  return messages.map((m, i) => `#${i} ${m.role}: ${body(m)}`).join("\n\n");
}

// The file mirror lets people and tools read each agent's context; the database stays the source of truth.
export function mirror(c: Pick<ToolContext, "store" | "contextDir">, agent: string) {
  const m = c.store.memory(agent)!;
  const live = liveMessages(c.store, agent);
  mkdirSync(c.contextDir, { recursive: true });
  Bun.write(join(c.contextDir, `${agent}.md`), `<!-- ${agent} context; generated from the database, edits are ignored -->\n# Working memory v${m.version}\n${m.memory}\n\n# Live context\n${live ? render(live) : "(no live task)"}\n`);
}
