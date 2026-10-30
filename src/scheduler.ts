import { BudgetExhausted, runEpisode, type Runtime } from "./agent.ts";
import type { Agent, Goal, Store, Task } from "./db.ts";
import { mirror } from "./tools.ts";
import { eligible, scan } from "./triggers.ts";

// State triggers (src/triggers.ts), such as an idle goal going back to its owner.
export const steer = scan;

function claimable(store: Store, agent: Agent) {
  const candidates = store.all<Task>(
    `select * from tasks where status = 'open' and (assignee is null or assignee = ?1) and (exclude is null or exclude != ?1)
     order by assignee is null, kind != 'verify', created_at`, agent.id);
  for (const t of candidates) if (eligible(store, agent, t) && store.claim(t.id, agent.id)) return store.task(t.id)!;
}

// A verify task excludes its author; if no active agent can take it, wake or create one rather than self-verify.
function unblockVerification(store: Store) {
  const blocked = store.all<Task>("select * from tasks where status = 'open' and kind = 'verify' and exclude is not null");
  for (const t of blocked) {
    const takers = store.all<Agent>("select * from agents where id != ?", t.exclude).filter(a => eligible(store, a, t));
    if (takers.some(a => a.status === "active")) continue;
    const dormant = takers.find(a => a.status === "dormant");
    if (dormant) {
      store.run("update agents set status = 'active', idle = 0 where id = ?", dormant.id);
      store.log("host", "agent_woken", { id: dormant.id, for: t.id });
      return true;
    }
    if (store.config.organization === "dynamic" && store.agents().length < store.config.maxAgents && !store.agent("verifier")) {
      store.addAgent("verifier", "verifier: independently checks results and knowledge against the actual artifacts and sources", "host");
      return true;
    }
  }
  return false;
}

export type Report = {
  status: "done" | "budget" | "stalled" | "error" | "rounds";
  rounds: number; modelCalls: number; elapsedMs: number;
  input: number; output: number; cacheRead: number; cacheWrite: number; maxPromptChars: number;
  agents: number; activeAgents: number; tasksDone: number; organizationChanges: number;
};

export function report(store: Store, status: Report["status"], rounds: number, elapsedMs: number): Report {
  const u = store.get<Record<string, number>>("select coalesce(sum(input),0) input, coalesce(sum(output),0) output, coalesce(sum(cache_read),0) cacheRead, coalesce(sum(cache_write),0) cacheWrite, coalesce(max(prompt_chars),0) maxPromptChars from usage")!;
  return {
    status, rounds, modelCalls: Number(store.meta("model_calls")), elapsedMs,
    input: u.input!, output: u.output!, cacheRead: u.cacheRead!, cacheWrite: u.cacheWrite!, maxPromptChars: u.maxPromptChars!,
    agents: store.agents().length, activeAgents: store.agents("active").length,
    tasksDone: store.get<{ n: number }>("select count(*) n from tasks where status = 'done' and kind = 'work'")!.n,
    organizationChanges: store.get<{ n: number }>("select count(*) n from log where event in ('agent_created', 'agent_dormant', 'agent_woken', 'goal_transferred', 'domain_split', 'domain_merged', 'domain_transferred')")!.n,
  };
}

export async function runScheduler(rt: Runtime, maxRounds = Infinity): Promise<Report> {
  const { store } = rt;
  const started = Date.now();
  store.adoptRunning();
  for (const a of store.agents()) mirror(rt, a.id);
  let round = 0, failedRounds = 0;
  for (; round < maxRounds; round++) {
    store.reclaimExpired();
    scan(store);
    if (store.goal("G0")!.status === "done") return report(store, "done", round, Date.now() - started);
    if (Number(store.meta("model_calls")) >= store.config.maxModelCalls) return report(store, "budget", round, Date.now() - started);

    // ponytail: single host process assumed; a second process would need a host lease before resuming running episodes
    const work: [Agent, Task][] = [];
    for (const agent of store.agents("active")) {
      if (work.length >= store.config.maxConcurrency) break;
      const resumable = store.get<Task>("select t.* from episodes e join tasks t on t.id = e.task where e.agent = ? and e.status = 'running' and t.status = 'claimed' and t.claimed_by = e.agent", agent.id);
      const task = resumable ?? claimable(store, agent);
      if (task) {
        work.push([agent, task]);
        store.run("update agents set idle = 0 where id = ?", agent.id);
      } else if ((store.config.organization === "dynamic" || store.config.organization === "market") && agent.id !== "lead" && agent.idle + 1 >= store.config.idleRounds) {
        store.run("update agents set status = 'dormant', idle = 0 where id = ?", agent.id);
        store.log("host", "agent_dormant", { id: agent.id, reason: "idle" });
      } else {
        store.run("update agents set idle = idle + 1 where id = ?", agent.id);
      }
    }
    if (!work.length) {
      if (unblockVerification(store)) continue;
      return report(store, "stalled", round, Date.now() - started);
    }

    // ponytail: rounds wait for the slowest episode; switch to a worker pool if agents' task lengths diverge a lot
    const results = await Promise.allSettled(work.map(([agent, task]) => runEpisode(rt, agent, task)));
    // Persistent provider errors (quota, auth) would otherwise spend the whole call budget on retries.
    failedRounds = results.every(r => r.status === "rejected" && !(r.reason instanceof BudgetExhausted)) ? failedRounds + 1 : 0;
    if (failedRounds >= 3) {
      rt.log?.(`stopping after ${failedRounds} rounds in which every episode failed`);
      return report(store, "error", round + 1, Date.now() - started);
    }
    for (const [i, r] of results.entries()) {
      const [agent, task] = work[i]!;
      if (r.status === "fulfilled") rt.log?.(`[${agent.id}] ${task.id} ${r.value}`);
      else {
        if (r.reason instanceof BudgetExhausted) continue;
        store.log(agent.id, "episode_error", { task: task.id, rev: task.rev, error: String(r.reason) });
        rt.log?.(`[${agent.id}] ${task.id} error: ${r.reason}`);
        // Repeated failures on the same claim give the task back instead of retrying forever.
        const failures = store.get<{ n: number }>("select count(*) n from log where event = 'episode_error' and agent = ? and json_extract(detail, '$.task') = ? and json_extract(detail, '$.rev') = ?", agent.id, task.id, task.rev)!.n;
        if (failures >= 3) store.tx(() => {
          store.run("update tasks set status = 'open', claimed_by = null, lease_until = null, feedback = ?, rev = rev + 1 where id = ? and claimed_by = ?", `previous attempt failed: ${String(r.reason).slice(0, 300)}`, task.id, agent.id);
          store.run("update episodes set status = 'failed' where agent = ? and task = ? and status = 'running'", agent.id, task.id);
        });
      }
    }
  }
  return report(store, "rounds", round, Date.now() - started);
}
