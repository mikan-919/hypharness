import type { Goal, Store } from "./db.ts";

// Triggers: which role an event or a state of the shared DeLM sets to work. Agents are not told what to do by a
// coordinator; a tool records an event (emit), and the matching triggers create tasks for the roles that handle it.
// Event triggers run inside the transaction of the tool that emitted the event, so the event and the tasks it fires
// are recorded together. State triggers are checked by the scheduler at the start of every round.

type Organization = Store["config"]["organization"];
type EventTrigger = { on: string; modes?: Organization[]; fire: (store: Store, agent: string, detail: Record<string, any>) => void };
type StateTrigger = { name: string; modes?: Organization[]; scan: (store: Store) => void };

// The verifier is always a different agent, except in single-agent mode where it is recorded as self-verification.
export function requestVerification(store: Store, goal: string, author: string, target: string, description: string) {
  return store.addTask({ goal, kind: "verify", author, exclude: store.config.maxAgents > 1 ? author : null, target, description });
}

export const EVENT_TRIGGERS: EventTrigger[] = [
  {
    on: "work_submitted",
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
];

export const STATE_TRIGGERS: StateTrigger[] = [
  {
    // Any open goal with nothing pending goes back to its owner to decide the next step (plan, act, refine, drop, or submit).
    name: "goal_idle",
    scan(store) {
      for (const g of store.all<Goal>("select * from goals where status = 'open'")) {
        const busy = store.get("select 1 from goals where parent = ?1 and status in ('open', 'review') union all select 1 from tasks where goal = ?1 and status in ('open', 'claimed', 'review')", g.id);
        if (busy) continue;
        store.addTask({
          goal: g.id, kind: "steer", author: "host", assignee: g.owner,
          description: `Goal ${g.id} has no pending work.\nGoal: ${g.description}${g.feedback ? `\nIts last submission was rejected: ${g.feedback}` : ""}\nDecide the next step: do the work yourself, create tasks or subgoals, refine or drop the goal, or submit it with goal_complete.`,
        });
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
