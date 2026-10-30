import type { Agent, Goal, Store, Task } from "./db.ts";
import { isSteward } from "./memory.ts";

// Triggers: which role an event or a state of the shared DeLM sets to work. Agents are not told what to do by a
// coordinator; a tool records an event (emit), and the matching triggers create tasks for the roles that handle it.
// Event triggers run inside the transaction of the tool that emitted the event, so the event and the tasks it fires
// are recorded together. State triggers are checked by the scheduler at the start of every round.
//
// In market mode the flow is: lead splits a goal (goal_created) -> the investor funds the subgoal with a model-call
// budget or declines it -> a worker does the funded task -> a critic objects to the result or passes it -> the
// evaluator rules on the objections. A task that spends its budget goes back to the investor.
// These roles work inside a harness session; the RSI loop's own investor and judges (scripts/rsi-judges.ts) are separate.

type Organization = Store["config"]["organization"];
type EventTrigger = { on: string; modes?: Organization[]; fire: (store: Store, agent: string, detail: Record<string, any>) => void };
type StateTrigger = { name: string; modes?: Organization[]; scan: (store: Store) => void };

const CLASSIC: Organization[] = ["single", "fixed", "dynamic"];
// Declined subgoals under one goal before the investor must fund something, so declining and re-splitting cannot loop.
export const MAX_DECLINES = 3;

// Market roles and the only task kinds each may take; any other agent is a worker.
export const ROLES: Record<string, { role: string; kinds: Task["kind"][] }> = {
  lead: { role: "lead: splits goals into subgoals and submits them; never does the work itself", kinds: ["steer"] },
  investor: { role: "investor: funds subgoals with a model-call budget when the expected return justifies it, declines the rest", kinds: ["invest"] },
  critic: { role: "critic: attacks finished work with concrete objections backed by evidence", kinds: ["critique"] },
  evaluator: { role: "evaluator: rules on each objection by checking its evidence, and decides whether the work stands", kinds: ["judge"] },
};

export const isMarket = (store: Store) => store.config.organization === "market";

// New knowledge in a domain since it was last organized before its steward is set to organize it.
export const ORGANIZE_EVERY = 12;
const ORGANIZE_BUDGET = 12;

// Whether an agent may claim a task: memory stewards take only organizing work and nobody else does; in market mode
// the roles take only their own kinds, and workers take everything else.
export function eligible(store: Store, agent: Agent, task: Pick<Task, "kind">) {
  if (isSteward(agent.id) || task.kind === "organize") return isSteward(agent.id) && task.kind === "organize";
  if (!isMarket(store)) return true;
  const r = ROLES[agent.id];
  return r ? r.kinds.includes(task.kind) : !Object.values(ROLES).some(x => x.kinds.includes(task.kind));
}

// Tools a role may not use; execute() rejects any tool missing from the agent's list.
export function withheldTools(store: Store, agent: Agent) {
  const withheld = new Set<string>();
  if (isSteward(agent.id)) for (const t of ["file_write", "shell", "task_create", "task_assign", "agent_spawn", "goal_create", "goal_complete", "goal_update", "goal_transfer"]) withheld.add(t);
  if (!(isMarket(store) && agent.id === "investor")) { withheld.add("goal_fund"); withheld.add("goal_decline"); }
  if (isMarket(store) && agent.id === "lead") for (const t of ["file_write", "shell", "task_create", "task_assign", "agent_spawn"]) withheld.add(t);
  return withheld;
}

// Wakes the agent for a role, or creates it the first time the role is needed.
function staff(store: Store, id: string) {
  const a = store.agent(id);
  if (!a) store.addAgent(id, ROLES[id]?.role ?? `${id}: does funded work tasks and verifies results`, "host");
  else if (a.status === "dormant") store.run("update agents set status = 'active', idle = 0 where id = ?", id);
  return id;
}

// The verifier is always a different agent, except in single-agent mode where it is recorded as self-verification.
export function requestVerification(store: Store, goal: string, author: string, target: string, description: string) {
  return store.addTask({ goal, kind: "verify", author, exclude: store.config.maxAgents > 1 ? author : null, target, description });
}

// Judge rulings so far: an upheld objection is a fail verdict against the work, an overruled one a pass.
export function criticRecord(store: Store) {
  const r = store.get<{ upheld: number; overruled: number }>("select coalesce(sum(result like 'fail:%'), 0) upheld, coalesce(sum(result like 'pass:%'), 0) overruled from tasks where kind = 'judge' and status = 'done'")!;
  return { upheld: Number(r.upheld), overruled: Number(r.overruled) };
}

function invest(store: Store, author: string, goal: Goal, why: string) {
  if (store.get("select 1 from tasks where kind = 'invest' and target = ? and status in ('open', 'claimed')", goal.id)) return;
  const siblings = store.all<{ status: string; feedback: string | null }>("select status, feedback from goals where parent = ? and id != ?", goal.parent, goal.id);
  const declined = siblings.filter(s => s.feedback?.startsWith("declined")).length;
  const spent = store.all<{ budget: number | null; used: number }>("select t.budget, (select count(*) from usage u where u.task = t.id) used from tasks t where t.goal = ? and t.budget is not null", goal.id);
  store.addTask({
    goal: goal.id, kind: "invest", author, assignee: staff(store, "investor"), target: goal.id,
    description: `${why}\nGoal ${goal.id}: ${goal.description}\nParent goal ${goal.parent}: ${store.goal(goal.parent!)?.description ?? "-"}\n`
      + `Funding so far for this goal: ${spent.length ? spent.map(s => `${s.used} of ${s.budget} calls used`).join("; ") : "none"}. Declined siblings: ${declined} of at most ${MAX_DECLINES}.\n`
      + `Decide with goal_fund (a model-call budget and why it should pay back) or goal_decline (why it is not worth it).`,
  });
}

function organize(store: Store, author: string, domain: string, why: string) {
  const d = store.get<{ id: string; name: string; description: string; steward: string; status: string }>("select * from domains where id = ?", domain);
  if (!d || d.status !== "active" || !isSteward(d.steward)) return;
  if (store.get("select 1 from tasks where kind = 'organize' and target = ? and assignee = ? and status in ('open', 'claimed')", domain, d.steward)) return;
  const n = (id: string) => store.get<{ n: number }>("select count(*) n from domain_knowledge where domain = ?", id)!.n;
  const others = store.all<{ id: string; name: string; steward: string }>("select id, name, steward from domains where status = 'active' and id != ? order by id", domain);
  const sample = store.all<{ gist: string }>("select k.gist from knowledge k join domain_knowledge dk on dk.knowledge = k.id where dk.domain = ? order by k.created_at desc limit 12", domain);
  store.run("update agents set status = 'active', idle = 0 where id = ? and status = 'dormant'", d.steward);
  store.addTask({
    goal: "G0", kind: "organize", author, assignee: d.steward, target: domain, budget: ORGANIZE_BUDGET,
    description: `${why}\nYou steward ${d.id} (${d.name}: ${d.description}), ${n(d.id)} knowledge items. Recent ones:\n${sample.map(s => `- ${s.gist}`).join("\n")}\n`
      + `Other domains: ${others.map(o => `${o.id} ${o.name} (n=${n(o.id)}, steward ${o.steward})`).join("; ") || "none"}.\n`
      + `Reorganize only if it makes knowledge easier to find: domain_split by topic, domain_merge domains you steward, or domain_request another steward's domain to merge it. Then task_finish with what you changed, or why nothing needed changing. Budget: ${ORGANIZE_BUDGET} model calls.`,
  });
}

export const EVENT_TRIGGERS: EventTrigger[] = [
  {
    // Memory handed to DeLM (src/chat.ts) sets the domain's steward to organize it once enough has accumulated.
    on: "memory_grown",
    fire(store, agent, d) {
      const now = store.get<{ n: number }>("select count(*) n from domain_knowledge where domain = ?", d.domain)!.n;
      if (now - Number(store.meta(`organized:${d.domain}`) ?? 0) >= ORGANIZE_EVERY) organize(store, agent, d.domain, `${d.added} new knowledge items arrived in ${d.domain}.`);
    },
  },
  {
    on: "transfer_requested",
    fire(store, agent, d) {
      organize(store, agent, d.domain, `${agent} asks you to transfer ${d.domain} to it: ${d.reason}\nIf that helps retrieval, hand it over with domain_transfer to ${agent}; otherwise finish and say why not.`);
    },
  },
  {
    on: "domain_transferred",
    fire(store, agent, d) {
      organize(store, agent, d.id, `${agent} transferred ${d.id} to you. Merge or reorganize it if that helps retrieval.`);
    },
  },
  {
    on: "work_submitted", modes: CLASSIC,
    fire(store, agent, d) {
      const task = store.task(d.task)!;
      requestVerification(store, task.goal, agent, task.id, `Verify task ${task.id}.\nTask: ${task.description}\nClaimed result: ${d.result}\nInspect the actual artifacts; do not trust the claim.`);
    },
  },
  {
    on: "goal_submitted",
    fire(store, agent, d) {
      const goal = store.goal(d.goal)!;
      requestVerification(store, goal.id, agent, goal.id, `Verify that goal ${goal.id} is achieved.\nGoal: ${goal.description}\nClaimed deliverable: ${d.deliverable}\nInspect the actual artifacts; do not trust the claim.`);
    },
  },
  {
    on: "goal_created", modes: ["market"],
    fire(store, agent, d) {
      const goal = store.goal(d.id)!;
      if (goal.parent) invest(store, agent, goal, `A new subgoal was split from ${goal.parent}.`);
    },
  },
  {
    on: "goal_funded", modes: ["market"],
    fire(store, agent, d) {
      const goal = store.goal(d.goal)!;
      store.addTask({
        goal: goal.id, kind: "work", author: agent, exclude: goal.owner, budget: d.budget,
        description: `Achieve goal ${goal.id}: ${goal.description}\nBudget: ${d.budget} model calls in total; the task goes back to the investor when they are spent.\nInvestor's rationale: ${d.rationale}`,
      });
    },
  },
  {
    on: "budget_exhausted", modes: ["market"],
    fire(store, agent, d) {
      invest(store, agent, store.goal(d.goal)!, `Funded task ${d.task} spent its budget of ${d.budget} model calls without finishing. Its last note: ${d.note ?? "-"}`);
    },
  },
  {
    on: "work_submitted", modes: ["market"],
    fire(store, agent, d) {
      const task = store.task(d.task)!, record = criticRecord(store);
      store.addTask({
        goal: task.goal, kind: "critique", author: agent, assignee: staff(store, "critic"), exclude: agent, target: task.id,
        description: `Task ${task.id} is finished and waits for review.\nTask: ${task.description}\nClaimed result: ${d.result}\n`
          + `Inspect the actual artifacts. If you find concrete problems, finish with verdict fail and list each objection with its evidence; otherwise finish with verdict pass.\n`
          + `An evaluator rules on your objections. Your record: ${record.upheld} upheld, ${record.overruled} overruled; overruled objections count against you.`,
      });
    },
  },
  {
    on: "objections_raised", modes: ["market"],
    fire(store, agent, d) {
      const task = store.task(d.target)!;
      store.addTask({
        goal: task.goal, kind: "judge", author: agent, assignee: staff(store, "evaluator"), target: task.id,
        description: `The critic objected to task ${task.id}.\nTask: ${task.description}\nClaimed result: ${task.result}\nObjections: ${d.objections}\n`
          + `Check each objection's evidence yourself. Finish with verdict fail if an objection holds (the work goes back with your reasons), or pass if none does.`,
      });
    },
  },
];

export const STATE_TRIGGERS: StateTrigger[] = [
  {
    // Any open goal with nothing pending goes back to its owner to decide the next step (plan, act, refine, drop, or submit).
    name: "goal_idle",
    scan(store) {
      const next = isMarket(store)
        ? "Decide the next step: split it into subgoals with goal_create (the investor funds or declines each), refine it, or submit it with goal_complete once its subgoals are done. You do not do the work yourself."
        : "Decide the next step: do the work yourself, create tasks or subgoals, refine or drop the goal, or submit it with goal_complete.";
      for (const g of store.all<Goal>("select * from goals where status = 'open'")) {
        const busy = store.get("select 1 from goals where parent = ?1 and status in ('open', 'review') union all select 1 from tasks where goal = ?1 and status in ('open', 'claimed', 'review')", g.id);
        if (busy) continue;
        store.addTask({
          goal: g.id, kind: "steer", author: "host", assignee: g.owner,
          description: `Goal ${g.id} has no pending work.\nGoal: ${g.description}${g.feedback ? `\nIts last submission was rejected: ${g.feedback}` : ""}\n${next}`,
        });
      }
    },
  },
  {
    // Funded work and verification need a worker; the market roles never take them.
    name: "unstaffed", modes: ["market"],
    scan(store) {
      const open = store.all<Task>("select * from tasks where status = 'open' and assignee is null and kind in ('work', 'verify')");
      for (const t of open) {
        const takers = store.agents().filter(a => eligible(store, a, t) && a.id !== t.exclude);
        if (takers.some(a => a.status === "active")) continue;
        const dormant = takers.find(a => a.status === "dormant");
        staff(store, dormant?.id ?? (t.exclude === "worker" ? "verifier" : "worker"));
      }
    },
  },
];

const applies = (t: { modes?: Organization[] }, store: Store) => !t.modes || t.modes.includes(store.config.organization);

// Records the event and fires its triggers; call it inside the emitting tool's transaction.
export function emit(store: Store, agent: string, event: string, detail: Record<string, any>) {
  store.log(agent, event, detail);
  for (const t of EVENT_TRIGGERS) if (t.on === event && applies(t, store)) t.fire(store, agent, detail);
}

export function scan(store: Store) {
  for (const t of STATE_TRIGGERS) if (applies(t, store)) t.scan(store);
}
