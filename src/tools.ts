import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { StringEnum, Type, type Message, type Static, type TSchema, type Tool } from "@earendil-works/pi-ai";
import type { Agent, Goal, Store, Task } from "./db.ts";
import { didWork, emit, MAX_DECLINES, panelVotes, requestVerification } from "./triggers.ts";
import { fetchPublicPage } from "./web-fetch.ts";
import { sandboxShell } from "./sandbox.ts";
import { recordToolKnowledge, type Embed } from "./resident-memory.ts";

// messages is the caller's live context for the current episode; context_edit changes it in place.
export type ToolContext = { store: Store; agent: Agent; task: Task; workspace: string; contextDir: string; episode: string; messages: Message[]; embed?: Embed; fetchPage?: typeof fetchPublicPage };
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

function requireInvest(c: ToolContext, goal: string) {
  const task = requireCurrent(c);
  if (task.kind !== "invest" || task.target !== goal) fail(`Your current task ${task.id} is not the invest task for ${goal}`);
  if (c.store.goal(goal)?.status !== "open") fail(`Goal ${goal} is not open`);
  return task;
}

// Settles a funding vote once every investor of the panel has voted: a majority to fund funds the goal with the median of
// their budgets, otherwise the goal is declined and goes back to its owner.
function decideInvestment(c: ToolContext, task: Task) {
  const votes = panelVotes(c.store, task);
  if (!votes) return "Vote recorded; the decision waits for the other investors";
  const goal = c.store.goal(task.target!)!;
  const funds = votes.map(v => v.result!.match(/^funded (\d+): ([\s\S]*)$/)).filter(m => m !== null);
  if (funds.length * 2 > votes.length) {
    const budgets = funds.map(m => Number(m[1])).sort((x, y) => x - y), budget = budgets[Math.floor((budgets.length - 1) / 2)]!;
    emit(c.store, c.agent.id, "goal_funded", { goal: goal.id, budget, rationale: funds.map(m => m[2]).join("\n") });
    return `Investors funded ${goal.id} with ${budget} model calls (${funds.length} of ${votes.length} voted to fund)`;
  }
  const reason = votes.filter(v => v.result!.startsWith("declined: ")).map(v => v.result!.slice(10)).join(" / ");
  c.store.run("update goals set status = 'dropped', feedback = ?, rev = rev + 1 where id = ?", `declined: ${reason}`, goal.id);
  c.store.run("update tasks set status = 'failed', feedback = 'goal declined' where goal = ? and status = 'open'", goal.id);
  emit(c.store, c.agent.id, "goal_declined", { goal: goal.id, reason });
  return `Investors declined ${goal.id} (${funds.length} of ${votes.length} voted to fund)`;
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

// Words of a query. Text without spaces (Japanese, Chinese) is matched by its overlapping character pairs.
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;
export const searchTerms = (query: string) => query.toLowerCase().replace(/[、。，．！？!?,.「」『』（）()"']/g, " ").split(/\s+/).filter(Boolean)
  .flatMap(w => CJK.test(w) && w.length > 2 ? Array.from({ length: w.length - 1 }, (_, i) => w.slice(i, i + 2)) : [w]);

// One URL per document: arXiv versions and mirrors become the abstract page; other URLs lose the fragment, "www." and a trailing slash.
// ponytail: arXiv is the only family of mirrors recognized; add patterns as other duplicated sources show up
const ARXIV = /^https?:\/\/(?:www\.|export\.)?(?:arxiv\.org|ar5iv\.labs\.arxiv\.org|ar5iv\.org|alphaxiv\.org|huggingface\.co)\/(?:abs|pdf|html|overview|papers)\/(\d{4}\.\d{4,5})/i;
export function canonicalUrl(url: string) {
  const arxiv = url.match(ARXIV);
  if (arxiv) return `https://arxiv.org/abs/${arxiv[1]}`;
  if (!URL.canParse(url)) return url;
  const u = new URL(url);
  u.hash = "";
  u.hostname = u.hostname.replace(/^www\./, "");
  return u.href.replace(/\/$/, "");
}

// A page already recorded: the same document, or the same title when it is long enough to name one work
// (a proceedings copy of an arXiv paper). A merged item resolves to the item it was merged into.
export function knownPage(store: Store, url: string, title: string) {
  return store.get<{ id: string }>("select coalesce(merged_into, id) id from knowledge where source = ?1 or (length(?2) >= 20 and lower(gist) = lower(?2)) order by created_at limit 1", canonicalUrl(url), title)?.id;
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
  memory_edit: def({
    description: "Change part of your own working memory: replace text that occurs exactly once with new text (empty to delete). Cheaper than rewriting it with memory_write; earlier versions remain restorable.",
    parameters: Type.Object({ old: Type.String({ minLength: 1, description: "Exact text to replace; must occur once" }), new: Str("Replacement text") }),
    run(c, a) {
      const current = c.store.memory(c.agent.id)!.memory;
      const hits = current.split(a.old).length - 1;
      if (hits !== 1) fail(hits ? `The text occurs ${hits} times; include more surrounding text` : "The text does not occur in your working memory");
      const next = current.replace(a.old, () => a.new);
      const limit = c.store.config.memoryLimit;
      if (next.length > limit) fail(`Working memory is limited to ${limit} characters (would be ${next.length}); compact it and move details into knowledge_add`);
      const version = c.store.writeMemory(c.agent.id, next);
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
      const replaced = JSON.stringify(m.slice(a.from, a.to + 1)).length;
      if (a.note.length >= replaced) fail(`An edit must shrink the context: the note (${a.note.length} chars) is not shorter than #${a.from}-#${a.to} (${replaced} chars)`);
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
      if (c.store.meta("resident") === "1") requireOwner(parent, c.agent);
      const id = c.store.id("G");
      c.store.run("insert into goals(id, parent, description, status, owner, created_at) values(?, ?, ?, 'open', ?, ?)", id, a.parent, a.description, c.agent.id, Date.now());
      emit(c.store, c.agent.id, "goal_created", { id, parent: a.parent });
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
        emit(c.store, c.agent.id, "goal_submitted", { goal: goal.id, deliverable: a.deliverable });
      });
      return `Goal ${goal.id} submitted for verification`;
    },
  }),

  // --- Market: the investor's decisions (src/triggers.ts) ---
  goal_fund: def({
    description: "Vote to fund the goal of your current invest task with a model-call budget. When a majority of the investors vote to fund, a worker does it within the median of their budgets; when that is spent the goal comes back to the investors.",
    parameters: Type.Object({ goal: Str("Goal ID of your invest task"), budget: Type.Integer({ minimum: 1, maximum: 200, description: "Model calls the work may use in total" }), rationale: Str("Why it should pay back, and what you expect") }),
    run(c, a) {
      const task = requireInvest(c, a.goal);
      return c.store.tx(() => {
        c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", `funded ${a.budget}: ${a.rationale}`, task.id);
        return decideInvestment(c, task);
      });
    },
  }),
  goal_decline: def({
    description: `Vote to decline the goal of your current invest task; without a majority to fund, it is dropped and its owner decides again. At most ${MAX_DECLINES} subgoals of the same goal can be declined.`,
    parameters: Type.Object({ goal: Str("Goal ID of your invest task"), reason: Str("Why it is not worth funding") }),
    run(c, a) {
      const task = requireInvest(c, a.goal), goal = c.store.goal(a.goal)!;
      const declined = c.store.get<{ n: number }>("select count(*) n from goals where parent = ? and feedback like 'declined%'", goal.parent)!.n;
      if (declined >= MAX_DECLINES) fail(`${declined} subgoals of ${goal.parent} were already declined; fund this one with a small budget instead`);
      return c.store.tx(() => {
        c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", `declined: ${a.reason}`, task.id);
        return decideInvestment(c, task);
      });
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
        if (task.kind === "invest") fail("Decide an invest task with goal_fund or goal_decline");
        if (task.kind === "organize") {
          c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", a.result, task.id);
          c.store.setMeta(`organized:${task.target}`, String(c.store.get<{ n: number }>("select count(*) n from domain_knowledge where domain = ?", task.target)!.n));
        } else if (task.kind === "critique" || task.kind === "judge") {
          if (!a.verdict) fail(`${task.kind} tasks need a verdict`);
          c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", `${a.verdict}: ${a.result}`, task.id);
          // The panel decides once every member has voted: any critic's objection goes to the evaluators, whose majority rules.
          const votes = panelVotes(c.store, task);
          if (votes) {
            const fails = votes.filter(v => v.result!.startsWith("fail: ")), reasons = (vs: Task[]) => vs.map(v => `${v.claimed_by}: ${v.result!.replace(/^\w+: /, "")}`).join("\n");
            if (task.kind === "critique" && fails.length) emit(c.store, c.agent.id, "objections_raised", { critique: task.panel ?? task.id, target: task.target, objections: reasons(fails) });
            else {
              const pass = fails.length * 2 <= votes.length;
              applyVerdict(c.store, c.agent.id, task.target!, pass, reasons(pass ? votes.filter(v => !fails.includes(v)) : fails));
              c.store.log(c.agent.id, "verified", { target: task.target, verdict: pass ? "pass" : "fail", by: task.kind, votes: votes.length, fails: fails.length });
            }
          }
        } else if (task.kind === "verify") {
          if (!a.verdict) fail("Verify tasks need a verdict");
          applyVerdict(c.store, c.agent.id, task.target!, a.verdict === "pass", a.result);
          c.store.run("update tasks set status = 'done', result = ?, rev = rev + 1 where id = ?", `${a.verdict}: ${a.result}`, task.id);
          c.store.log(c.agent.id, "verified", { target: task.target, verdict: a.verdict, self: didWork(c.store, c.agent.id, task.target!) });
        } else if (task.kind === "work") {
          c.store.run("update tasks set status = 'review', result = ?, rev = rev + 1 where id = ?", a.result, task.id);
          emit(c.store, c.agent.id, "work_submitted", { task: task.id, result: a.result });
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
      if (c.store.meta("resident") === "1") {
        if (a.domain) requireSteward(c.store, a.domain, c.agent);
        const embed = c.embed ?? fail("Resident knowledge requires an embedder");
        return recordToolKnowledge(c.store, embed, { id, gist: a.gist, summary: a.summary, raw: a.raw, source: a.source, author: c.agent.id })
          .then(() => `Recorded ${id} as hypothesis; use knowledge_verify to have it checked`);
      }
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
      const words = searchTerms(a.query);
      const rows = c.store.all<{ id: string; gist: string; summary: string; status: string }>(
        "select k.* from knowledge k where (?1 is null or k.id in (select knowledge from domain_knowledge where domain = ?1)) and (?2 is null or k.status = ?2) and k.status != 'merged'",
        a.domain ?? null, a.status ?? null);
      // A match in the gist counts double: items that share a summary (sentences of one turn) then rank by their own words,
      // and only the best of them is listed, so one long turn cannot fill the results.
      // ponytail: linear scan with word counting; switch to SQLite FTS5 when knowledge grows past a few thousand rows
      const shown = new Set<string>();
      return rows.map(k => ({ k, score: words.reduce((n, w) => n + (k.gist.toLowerCase().includes(w) ? 2 : 0) + (k.summary.toLowerCase().includes(w) ? 1 : 0), 0) }))
        .filter(r => r.score > 0 || !words.length).sort((x, y) => y.score - x.score)
        .filter(({ k }) => !shown.has(k.summary) && shown.add(k.summary)).slice(0, 12)
        .map(({ k }) => `${k.id} [${k.status}] ${k.gist}`).join("\n") || "No matches";
    },
  }),
  knowledge_get: def({
    description: "Expand a knowledge item to its summary, or to raw evidence when you need the basis.",
    parameters: Type.Object({ id: Str("Knowledge ID"), level: StringEnum(["summary", "raw"]) }),
    run(c, a) {
      const k = c.store.get<Record<string, string>>("select * from knowledge where id = ?", a.id) ?? fail(`Unknown knowledge ${a.id}`);
      const domains = c.store.all<{ domain: string }>("select domain from domain_knowledge where knowledge = ?", a.id).map(d => d.domain);
      return `${k.merged_into ? `${k.id} was merged into ${k.merged_into}; use that ID\n` : ""}${k.id} [${k.status}${k.verified_by ? ` by ${k.verified_by}` : ""}] source=${k.source} domains=${domains.join(",") || "-"}\ngist: ${k.gist}\nsummary: ${k.summary}${a.level === "raw" ? `\nraw: ${k.raw}` : ""}`;
    },
  }),
  knowledge_verify: def({
    description: "Request independent verification of a hypothesis.",
    parameters: Type.Object({ id: Str("Knowledge ID") }),
    run(c, a) {
      const k = c.store.get<Record<string, string>>("select * from knowledge where id = ?", a.id) ?? fail(`Unknown knowledge ${a.id}`);
      if (k.merged_into) fail(`${a.id} was merged into ${k.merged_into}; verify that instead`);
      if (k.status !== "hypothesis") fail(`${a.id} is already ${k.status}`);
      if (c.store.get("select id from tasks where target = ? and status in ('open', 'claimed')", a.id)) fail(`Verification of ${a.id} is already pending`);
      const id = requestVerification(c.store, c.task.goal, k.author!, a.id, `Verify knowledge ${a.id} against its source.\ngist: ${k.gist}\nsummary: ${k.summary}\nsource: ${k.source}\nCheck the raw evidence (knowledge_get level=raw) and the source itself.`);
      return `Created verification task ${id}`;
    },
  }),
  knowledge_merge: def({
    description: "Fold duplicates into one knowledge item: items that record the same document (another version, mirror or copy) or the same claim. Each duplicate points to the kept item from then on, and its domain links move there.",
    parameters: Type.Object({ keep: Str("Knowledge ID to keep"), duplicates: Type.Array(Type.String(), { minItems: 1, maxItems: 20, description: "Knowledge IDs that duplicate it" }), reason: Str("Why they are the same") }),
    run(c, a) {
      const get = (id: string) => c.store.get<{ id: string; status: string; merged_into: string | null }>("select id, status, merged_into from knowledge where id = ?", id) ?? fail(`Unknown knowledge ${id}`);
      const keep = get(a.keep);
      if (keep.merged_into) fail(`${keep.id} was merged into ${keep.merged_into}; keep that instead`);
      return c.store.tx(() => {
        for (const id of new Set(a.duplicates)) {
          const d = get(id);
          if (d.id === keep.id) fail("An item cannot be its own duplicate");
          if (d.merged_into) fail(`${d.id} was already merged into ${d.merged_into}`);
          // Merging must not lose a verification: the kept item has to be at least as established.
          if (d.status === "verified" && keep.status !== "verified") fail(`${d.id} is verified and ${keep.id} is not; keep ${d.id} instead`);
          c.store.run("update knowledge set status = 'merged', merged_into = ? where id = ?", keep.id, d.id);
          c.store.run("insert or ignore into domain_knowledge(domain, knowledge) select domain, ? from domain_knowledge where knowledge = ?", keep.id, d.id);
          c.store.run("delete from domain_knowledge where knowledge = ?", d.id);
        }
        c.store.log(c.agent.id, "knowledge_merged", { keep: keep.id, duplicates: a.duplicates, reason: a.reason });
        return `Merged ${a.duplicates.join(", ")} into ${keep.id}`;
      });
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
      c.store.tx(() => {
        c.store.run("update domains set steward = ?, rev = rev + 1 where id = ? and steward = ?", a.to, a.id, c.agent.id);
        emit(c.store, c.agent.id, "domain_transferred", { id: a.id, to: a.to });
      });
      return `Domain ${a.id} now stewarded by ${a.to}`;
    },
  }),

  domain_request: def({
    description: "Ask the steward of another domain to transfer it to you, for example to merge it with a domain you steward. Its steward decides.",
    parameters: Type.Object({ domain: Str("Domain ID"), reason: Str("What you would do with it and why that helps retrieval") }),
    run(c, a) {
      const d = c.store.get<{ steward: string; status: string }>("select steward, status from domains where id = ?", a.domain) ?? fail(`Unknown domain ${a.domain}`);
      if (d.status !== "active") fail(`Domain ${a.domain} is ${d.status}`);
      if (d.steward === c.agent.id) fail(`You already steward ${a.domain}`);
      emit(c.store, c.agent.id, "transfer_requested", { domain: a.domain, steward: d.steward, reason: a.reason });
      return `Asked ${d.steward} to transfer ${a.domain}`;
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
  agent_split: def({
    description: "Split yourself: hand independent parts of your current work task to copies of you (same role, a copy of your working memory) that work on them in parallel. Each part takes its budget out of your task's remaining budget. Keep the rest, and how the parts fit together, for yourself.",
    parameters: Type.Object({
      parts: Type.Array(Type.Object({ description: Str("Self-contained part: what to do, where to write it, how success is checked"), budget: Opt(Type.Integer({ minimum: 1, description: "Model calls for this part; required when your task has a budget" })) }), { minItems: 1, maxItems: 4 }),
      reason: Str("Why these parts go faster or better in parallel"),
    }),
    run(c, a) {
      const task = requireCurrent(c);
      if (task.kind !== "work") fail("Only a work task can be split");
      const budgeted = task.budget !== null;
      if (a.parts.some(p => (p.budget === undefined) === budgeted)) fail(budgeted ? "Give each part a budget" : "Your task has no budget; leave the parts' budgets out");
      const given = a.parts.reduce((n, p) => n + (p.budget ?? 0), 0);
      return c.store.tx(() => {
        if (budgeted) {
          const left = task.budget! - c.store.get<{ n: number }>("select count(*) n from usage where task = ?", task.id)!.n;
          if (given >= left) fail(`The parts need ${given} model calls but your task has ${left} left, and you need at least one to finish`);
          c.store.run("update tasks set budget = budget - ? where id = ?", given, task.id);
        }
        const memory = c.store.memory(c.agent.id)!.memory, base = c.agent.id.replace(/-\d+$/, "");
        const created = a.parts.map(p => {
          // A dormant copy of the same role is reused before a new one is made.
          let copy = c.store.get<Agent>("select * from agents where role = ? and status = 'dormant' and id != ? order by created_at", c.agent.role, c.agent.id)?.id;
          if (copy) c.store.run("update agents set status = 'active', idle = 0 where id = ?", copy);
          else {
            if (c.store.agents().length >= c.store.config.maxAgents) fail(`Agent limit ${c.store.config.maxAgents} reached`);
            let n = 2;
            while (c.store.agent(`${base}-${n}`)) n++;
            c.store.addAgent(copy = `${base}-${n}`, c.agent.role, c.agent.id);
          }
          c.store.writeMemory(copy, memory);
          mirror(c, copy);
          const id = c.store.addTask({
            goal: task.goal, kind: "work", author: c.agent.id, assignee: copy, budget: p.budget ?? null,
            description: `Part of task ${task.id}, split off by ${c.agent.id}: ${p.description}\nThe whole task: ${task.description}`,
          });
          return `${id} -> ${copy}`;
        });
        c.store.log(c.agent.id, "agent_split", { task: task.id, parts: created, reason: a.reason });
        return `Split ${task.id}: ${created.join(", ")}${budgeted ? `; your task keeps ${task.budget! - given} model calls` : ""}`;
      });
    },
  }),
  agent_merge: def({
    description: "Merge yourself into another agent of the same role when you are no longer needed as a separate agent: your working memory is appended to its memory and you retire for good. Finish your current task afterwards.",
    parameters: Type.Object({ into: Str("Agent of your role that takes over your memory"), reason: Str("Why a separate agent is no longer worth it") }),
    run(c, a) {
      const target = c.store.agent(a.into) ?? fail(`Unknown agent ${a.into}`);
      if (target.id === c.agent.id) fail("Cannot merge into yourself");
      if (target.role !== c.agent.role || target.status === "merged") fail(`${a.into} is not an agent of your role that can take you over`);
      return c.store.tx(() => {
        if (c.store.get("select id from tasks where (claimed_by = ?1 and status = 'claimed' and id != ?2) or (assignee = ?1 and status = 'open')", c.agent.id, c.task.id)) fail("You still have tasks; finish or release them first");
        const mine = c.store.memory(c.agent.id)!.memory, theirs = c.store.memory(target.id)!.memory;
        const merged = mine ? `${theirs}${theirs ? "\n\n" : ""}## Merged from ${c.agent.id}\n${mine}` : theirs;
        if (merged.length > c.store.config.memoryLimit) fail(`Merged memory would be ${merged.length} characters, over the limit of ${c.store.config.memoryLimit}; compact your memory first`);
        if (merged !== theirs) c.store.writeMemory(target.id, merged);
        c.store.run("update agents set status = 'merged' where id = ?", c.agent.id);
        c.store.log(c.agent.id, "agent_merged", { id: c.agent.id, into: target.id, reason: a.reason });
        mirror(c, target.id);
        return `Merged into ${target.id}; finish your current task`;
      });
    },
  }),

  // --- External information ---
  web_fetch: def({
    description: "Fetch a public HTTP(S) page and record its text as unverified knowledge.",
    parameters: Type.Object({ url: Str("Public HTTP(S) URL") }),
    async run(c, a) {
      const page = await (c.fetchPage ?? fetchPublicPage)(a.url);
      const source = canonicalUrl(page.url);
      // A page recorded before (often as a search excerpt) keeps its ID; the fetched text replaces shorter unverified evidence.
      const known = knownPage(c.store, page.url, page.url);
      if (known) {
        c.store.run("update knowledge set raw = ?1, summary = ?2 where id = ?3 and status = 'hypothesis' and length(raw) < length(?1)", page.text, page.text.slice(0, 500), known);
        return `${known} ${page.url} (already recorded)\n${page.text}`.slice(0, c.store.config.toolOutputLimit);
      }
      if (c.store.meta("resident") === "1") {
        const id = c.store.id("K"), embed = c.embed ?? fail("Resident knowledge requires an embedder");
        await recordToolKnowledge(c.store, embed, { id, gist: page.url, summary: page.text.slice(0, 500), raw: page.text, source, author: c.agent.id });
        return `${id} ${page.url}\n${page.text}`.slice(0, c.store.config.toolOutputLimit);
      }
      const id = c.store.tx(() => {
        const id = c.store.id("K");
        c.store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, ?, ?, ?, 'hypothesis', ?, ?)",
          id, page.url, page.text.slice(0, 500), page.text, source, c.agent.id, Date.now());
        c.store.log(c.agent.id, "knowledge_added", { id, gist: page.url, from: "web_fetch" });
        return id;
      });
      return `${id} ${page.url}\n${page.text}`.slice(0, c.store.config.toolOutputLimit);
    },
  }),
  web_search: def({
    description: "Search the web with Parallel. Returns ranked URLs with excerpts. Each result is recorded as unverified knowledge with the URL as source (one item per document, so versions and mirrors of one paper share an ID; its ID is shown), so check knowledge_search before searching again.",
    parameters: Type.Object({
      objective: Str("Self-contained statement of what you are looking for and why"),
      queries: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "2-3 keyword queries of 3-6 words each" }),
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
          objective: a.objective, search_queries: a.queries, mode: "fast", session_id: c.task.id,
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
      // The host records what was found, so sources stay reusable without a knowledge_add call per result.
      const found = (body.results ?? []).map(r => ({ ...r, title: r.title ?? "(untitled)", excerpt: (r.excerpts ?? []).join("\n…\n") }));
      if (c.store.meta("resident") === "1") {
        const embed = c.embed ?? fail("Resident knowledge requires an embedder");
        const ids: string[] = [];
        for (const r of found) {
          const known = knownPage(c.store, r.url, r.title);
          ids.push(known ?? await recordToolKnowledge(c.store, embed, { id: c.store.id("K"), gist: r.title, summary: r.excerpt.slice(0, 500), raw: r.excerpt, source: canonicalUrl(r.url), author: c.agent.id, dedupeSource: true }));
        }
        const results = found.map((r, i) => `[${i + 1}] ${ids[i]} ${r.title}${r.publish_date ? ` (${r.publish_date})` : ""}\n${r.url}\n${r.excerpt}`);
        return [...warnings, ...results].join("\n\n") || "No results";
      }
      const ids = c.store.tx(() => found.map(r => {
        const known = knownPage(c.store, r.url, r.title);
        if (known) return known;
        const id = c.store.id("K");
        c.store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, ?, ?, ?, 'hypothesis', ?, ?)",
          id, r.title, r.excerpt.slice(0, 500), r.excerpt, canonicalUrl(r.url), c.agent.id, Date.now());
        c.store.log(c.agent.id, "knowledge_added", { id, gist: r.title, from: "web_search" });
        return id;
      }));
      const results = found.map((r, i) => `[${i + 1}] ${ids[i]} ${r.title}${r.publish_date ? ` (${r.publish_date})` : ""}\n${r.url}\n${r.excerpt}`);
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
    description: "Run a shell command in an isolated workspace (60 s timeout). Requires host permission (--allow-shell) and bubblewrap.",
    parameters: Type.Object({ command: Type.String() }),
    async run(c, a) {
      if (!c.store.config.allowShell) fail("Shell is not permitted by the host; start the harness with --allow-shell to grant it");
      const proc = Bun.spawn(sandboxShell(c.workspace, a.command), { stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return `exit ${code}\n${out}${err ? `\nstderr:\n${err}` : ""}`;
    },
  }),
};

// Tools that need host configuration are left out of the model's tool list when it is missing.
export function toolSchemas(): Tool[] {
  return Object.entries(tools)
    .filter(([name]) => name !== "web_search" || process.env.PARALLEL_API_KEY)
    .filter(([name]) => name !== "shell" || Bun.which("bwrap"))
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
