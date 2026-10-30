import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { Runtime } from "./agent.ts";
import { defaultConfig, Store } from "./db.ts";
import { runScheduler } from "./scheduler.ts";
import { tools, type ToolContext } from "./tools.ts";
import { emit, MAX_DECLINES, withheldTools } from "./triggers.ts";

type Ctx = { messages: Message[] };
const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

// Scripted market roles: the kind of the claimed task tells each role what to do.
function market(opts: { budget: number; workerLoops?: boolean }) {
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
