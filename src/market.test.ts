import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { systemPrompt, type Runtime } from "./agent.ts";
import { centralization, defaultConfig, Store } from "./db.ts";
import { runScheduler } from "./scheduler.ts";
import { tools, type ToolContext } from "./tools.ts";
import { emit, MAX_DECLINES, withheldTools } from "./triggers.ts";

type Ctx = { messages: Message[] };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

// Scripted market roles: the kind of the claimed task tells each role what to do.
function market(opts: { budget: number; workerLoops?: boolean; splits?: boolean }) {
  let split = false;
  const brain = (ctx: Ctx) => {
    const first = ctx.messages.find(m => m.role === "user")!.content as string | { text?: string }[];
    const opening = typeof first === "string" ? first : first.map(b => b.text ?? "").join("");
    const used = ctx.messages.filter(m => m.role === "toolResult").map(m => m.toolName);
    const kind = opening.match(/## Current task \S+ \((\w+)/)![1];
    if (kind === "steer") {
      const goal = opening.match(/Goal (\S+) has no pending work/)![1]!;
      if (goal === "G0" && !split) {
        if (!used.includes("goal_create")) return call("goal_create", { parent: "G0", description: "write answer.txt" });
        split = true;
        return call("task_finish", { result: "split into one subgoal" });
      }
      if (!used.includes("goal_complete")) return call("goal_complete", { id: goal, deliverable: "answer.txt" });
      return call("task_finish", { result: "submitted" });
    }
    if (kind === "invest") return call("goal_fund", { goal: opening.match(/Goal (G-\w+): /)![1]!, budget: opts.budget, rationale: "one file write" });
    if (kind === "work") {
      if (opts.workerLoops) return call("file_list", {});
      if (opening.includes("Part of task")) {
        if (!used.includes("file_write")) return call("file_write", { path: "part.txt", content: "Bergen" });
        return call("task_finish", { result: "part.txt" });
      }
      if (opts.splits && !used.includes("agent_split")) return call("agent_split", { parts: [{ description: "write part.txt", budget: 3 }], reason: "independent file" });
      if (!used.includes("file_write")) return call("file_write", { path: "answer.txt", content: "Oslo" });
      return call("task_finish", { result: "answer.txt" });
    }
    return call("task_finish", { result: "checked answer.txt", verdict: "pass" }); // critique, verify
  };
  return { brain };
}

function setup(m: ReturnType<typeof market>) {
  const dir = mkdtempSync(join(tmpdir(), "hyph-market-"));
  const store = new Store(join(dir, "state.sqlite"));
  store.init("Answer in answer.txt", "", { ...defaultConfig, organization: "market", maxModelCalls: 60 });
  mkdirSync(join(dir, "workspace"), { recursive: true });
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array(100).fill(m.brain));
  const rt: Runtime = { store, models, model: faux.getModel(), workspace: join(dir, "workspace"), contextDir: join(dir, "contexts"), log: process.env.DEBUG ? console.log : undefined };
  return { store, rt };
}

test("market: lead splits, the investor funds, a worker answers, the critic passes it, and lead submits", async () => {
  const m = market({ budget: 5 });
  const { store, rt } = setup(m);
  expect((await runScheduler(rt)).status).toBe("done");
  expect(readFileSync(join(rt.workspace, "answer.txt"), "utf8")).toBe("Oslo");
  const kinds = store.all<{ kind: string; claimed_by: string; status: string }>("select kind, claimed_by, status from tasks order by created_at");
  expect(kinds.filter(t => t.kind === "invest").map(t => t.claimed_by)).toEqual(["investor"]);
  expect(kinds.filter(t => t.kind === "critique").map(t => [t.claimed_by, t.status])).toEqual([["critic", "done"]]);
  // lead never does or claims work, and its tools exclude doing it.
  expect(kinds.filter(t => t.claimed_by === "lead").every(t => t.kind === "steer")).toBe(true);
  const withheld = (id: string) => withheldTools(store, store.agent(id)!);
  expect(withheld("lead").has("file_write") && withheld("lead").has("goal_fund")).toBe(true);
  expect(withheld("investor").has("goal_fund")).toBe(false);
  expect(withheld("worker").has("goal_fund") && !withheld("worker").has("file_write")).toBe(true);
  expect(store.get<{ budget: number }>("select budget from tasks where kind = 'work'")!.budget).toBe(5);
});

test("market: a task that spends its budget fails and goes back to the investor", async () => {
  const { store, rt } = setup(market({ budget: 2, workerLoops: true }));
  await runScheduler(rt, 6);
  const work = store.get<{ id: string; status: string; feedback: string }>("select * from tasks where kind = 'work'")!;
  expect([work.status, work.feedback]).toEqual(["failed", "budget exhausted"]);
  expect(store.get<{ n: number }>("select count(*) n from usage where task = ?", work.id)!.n).toBe(2);
  const refund = store.all<{ description: string }>("select description from tasks where kind = 'invest' order by created_at").at(1);
  expect(refund?.description).toContain(`spent its budget of 2 model calls`);
});

test("market: the investor can decline only a limited number of subgoals of one goal", () => {
  const store = new Store(":memory:");
  store.init("p", "", { ...defaultConfig, organization: "market" });
  const lead = store.agent("lead")!;
  const ctx = (agent: string, task: string) => ({ store, agent: store.agent(agent)!, task: store.task(task)!, workspace: "", contextDir: "", episode: "e", messages: [] }) as ToolContext;
  const decline = () => {
    const goal = store.id("G");
    store.run("insert into goals(id, parent, description, status, owner, created_at) values(?, 'G0', 'sub', 'open', 'lead', 0)", goal);
    store.tx(() => emit(store, lead.id, "goal_created", { id: goal, parent: "G0" }));
    const task = store.get<{ id: string }>("select id from tasks where kind = 'invest' and target = ?", goal)!.id;
    expect(store.claim(task, "investor")).toBe(true);
    return () => tools.goal_decline!.run(ctx("investor", task), { goal, reason: "not worth it" });
  };
  for (let i = 0; i < MAX_DECLINES; i++) expect(decline()()).toStartWith("Declined");
  expect(() => decline()()).toThrow("fund this one with a small budget instead");
  // Only the investor's invest task can fund or decline.
  expect(() => tools.goal_fund!.run(ctx("lead", store.get<{ id: string }>("select id from tasks where kind = 'invest' and status = 'claimed'")!.id), { goal: "G0", budget: 1, rationale: "x" })).toThrow();
});

test("market: an objection goes to the evaluator, whose ruling decides the work and the critic's record", () => {
  const store = new Store(":memory:");
  store.init("p", "", { ...defaultConfig, organization: "market" });
  store.addAgent("worker", "worker", "host");
  const ctx = (agent: string, task: string) => ({ store, agent: store.agent(agent)!, task: store.task(task)!, workspace: "", contextDir: "", episode: "e", messages: [] }) as ToolContext;
  const finish = (agent: string, kind: string, verdict?: "pass" | "fail", result = "r") => {
    const t = store.get<{ id: string }>("select id from tasks where kind = ? and status = 'open'", kind)!.id;
    expect(store.claim(t, agent)).toBe(true);
    tools.task_finish!.run(ctx(agent, t), { result, verdict });
    return t;
  };
  const work = store.addTask({ goal: "G0", kind: "work", description: "write answer.txt", author: "lead", exclude: "lead", budget: 5 });
  finish("worker", "work", undefined, "answer.txt");
  expect(store.task(work)!.status).toBe("review");
  finish("critic", "critique", "fail", "answer.txt is empty");
  expect(store.task(work)!.status).toBe("review");
  expect(store.get<{ description: string }>("select description from tasks where kind = 'judge'")!.description).toContain("answer.txt is empty");
  finish("evaluator", "judge", "fail", "the file is empty");
  expect([store.task(work)!.status, store.task(work)!.feedback]).toEqual(["open", "the file is empty"]);
  // The next critique shows the critic its record.
  finish("worker", "work", undefined, "answer.txt now has the answer");
  expect(store.get<{ description: string }>("select description from tasks where kind = 'critique' and status = 'open'")!.description).toContain("Your record: 1 upheld, 0 overruled");
  finish("critic", "critique", "pass");
  expect(store.task(work)!.status).toBe("done");
});

test("centralization shows lead's share of calls, the agents, and the most domains one steward holds", () => {
  const store = new Store(":memory:");
  store.init("p", "", defaultConfig);
  for (const agent of ["lead", "lead", "lead", "worker"]) store.run("insert into usage(agent, task, input, output, cache_read, cache_write, prompt_chars, ms, at) values(?, 't', 1, 1, 0, 0, 0, 0, 0)", agent);
  store.run("insert into domains(id, name, description, steward, status) values('D1', 'a', 'a', 'lead', 'active'), ('D2', 'b', 'b', 'lead', 'active'), ('D3', 'c', 'c', 'x', 'retired')");
  expect(centralization(store.db)).toEqual({ leadShare: 0.75, agents: 1, maxDomainsPerSteward: 2 });
});

test("market: a worker splits off a part to a copy of itself, which does it on a share of the budget", async () => {
  const { store, rt } = setup(market({ budget: 8, splits: true }));
  expect((await runScheduler(rt)).status).toBe("done");
  expect(readFileSync(join(rt.workspace, "part.txt"), "utf8")).toBe("Bergen");
  const copy = store.agent("worker-2")!;
  expect([copy.role, copy.parent]).toEqual([store.agent("worker")!.role, "worker"]);
  const work = store.all<{ claimed_by: string; budget: number; status: string }>("select claimed_by, budget, status from tasks where kind = 'work' order by created_at");
  expect(work).toEqual([{ claimed_by: "worker", budget: 5, status: "done" }, { claimed_by: "worker-2", budget: 3, status: "done" }]);
  // Each part is critiqued on its own by the critic.
  expect(store.get<{ n: number }>("select count(*) n from tasks where kind = 'critique' and status = 'done' and claimed_by = 'critic'")!.n).toBe(2);
  // Neither the worker nor its copy verifies the goal they worked on; a verifier is staffed for it.
  const verifiers = store.all<{ claimed_by: string }>("select claimed_by from tasks where kind = 'verify'").map(t => t.claimed_by);
  expect(verifiers.length).toBeGreaterThan(0);
  expect(verifiers.every(v => v === "verifier")).toBe(true);
  expect(store.all<{ verified_by: string }>("select verified_by from goals where parent = 'G0'").map(g => g.verified_by)).toEqual(["verifier"]);
  expect(store.all<{ detail: string }>("select detail from log where event = 'verified' and detail like '%\"self\"%'").every(l => JSON.parse(l.detail).self === false)).toBe(true);
});

test("agent_split checks the budget, and agent_merge folds a copy's memory into another of its role and retires it", () => {
  const store = new Store(":memory:");
  store.init("p", "", { ...defaultConfig, organization: "market" });
  store.addAgent("worker", "worker: does funded work tasks and verifies results", "host");
  store.writeMemory("worker", "sources in K-1");
  const contextDir = mkdtempSync(join(tmpdir(), "hyph-ctx-"));
  const ctx = (agent: string, task: string) => ({ store, agent: store.agent(agent)!, task: store.task(task)!, workspace: "", contextDir, episode: "e", messages: [] }) as ToolContext;
  const task = store.addTask({ goal: "G0", kind: "work", description: "survey", author: "investor", budget: 6 });
  expect(store.claim(task, "worker")).toBe(true);
  const split = (parts: { description: string; budget?: number }[]) => tools.agent_split!.run(ctx("worker", task), { parts, reason: "parallel" });
  expect(() => split([{ description: "a", budget: 6 }])).toThrow("6 left");
  expect(() => split([{ description: "a" }])).toThrow("Give each part a budget");
  expect(split([{ description: "a", budget: 2 }, { description: "b", budget: 2 }])).toContain("keeps 2 model calls");
  expect(store.agents().map(a => a.id)).toEqual(["lead", "worker", "worker-2", "worker-3"]);
  expect(store.memory("worker-3")!.memory).toBe("sources in K-1");

  // worker-2 finishes its part and merges back; it is never reused, and the next split wakes the dormant worker-3 instead.
  const part = store.get<{ id: string }>("select id from tasks where assignee = 'worker-2'")!.id;
  expect(store.claim(part, "worker-2")).toBe(true);
  store.writeMemory("worker-2", "part a in a.md");
  expect(() => tools.agent_merge!.run(ctx("worker-2", part), { into: "lead", reason: "done" })).toThrow("not an agent of your role");
  tools.agent_merge!.run(ctx("worker-2", part), { into: "worker", reason: "done" });
  expect(store.agent("worker-2")!.status).toBe("merged");
  expect(store.memory("worker")!.memory).toBe("sources in K-1\n\n## Merged from worker-2\npart a in a.md");
  store.run("update agents set status = 'dormant' where id = 'worker-3'");
  split([{ description: "c", budget: 1 }]);
  expect(store.get<{ assignee: string }>("select assignee from tasks where description like 'Part of task %: c%'")!.assignee).toBe("worker-3");
  expect(store.agent("worker-3")!.status).toBe("active");
});

test("market prompts cast workers as innovators who argue their case and the market roles as capitalists who judge it", () => {
  const store = new Store(":memory:");
  store.init("p", "", { ...defaultConfig, organization: "market" });
  for (const id of ["investor", "critic", "worker-2"]) store.addAgent(id, id, "host");
  const prompt = (id: string) => systemPrompt(store, store.agent(id)!);
  expect(prompt("worker-2")).toContain("You are an innovator");
  expect(prompt("worker-2")).toContain("why it is promising");
  for (const id of ["investor", "critic"]) expect(prompt(id)).toContain("You are a capitalist");
  expect(prompt("lead")).toContain("You are lead");
  const classic = new Store(":memory:");
  classic.init("p", "", defaultConfig);
  expect(systemPrompt(classic, classic.agent("lead")!)).not.toContain("capitalism");
});
