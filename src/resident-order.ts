import type { Store } from "./db.ts";
import type { Embed } from "./resident-memory.ts";
import { distance, vectors } from "./resident-memory.ts";
import { rewardStrategy } from "./resident-roles.ts";

type Ask = (role: string, prompt: string) => Promise<Record<string, unknown>>;

// A user order is itself authority to propose work, not a claim of a discovery from two independent memories.
export async function proposeOrder(store: Store, embed: Embed, ask: Ask) {
  const purpose = store.purpose;
  const order = store.get<{ id: number }>("select id from log where event = 'order_changed' order by id desc limit 1");
  if (!purpose || !order || store.meta(`order_proposal:${order.id}`)) return false;
  const query = await embed(purpose, "query");
  const candidates = vectors(store).filter(v => !store.get("select 1 from knowledge where id = ? and source = ?", v.knowledge, `order:${order.id}`)
    && store.get("select 1 from memory_vectors v left join chat c on c.id = v.chat_id where v.knowledge = ? and (v.chat_id is null or c.remembered = 1)", v.knowledge));
  const nearest = candidates.map(v => ({ ...v, d: distance(query, v.vector) })).sort((a, b) => a.d - b.d)[0];
  const memory = nearest && store.get<{ raw: string }>("select raw from knowledge where id = ?", nearest.knowledge);
  const state = nearest ? store.get<{ domain: string; capital: number; credit: number }>("select domain, capital, credit from memory_stewards where domain = ? and active = 1", nearest.domain)
    : store.get<{ domain: string; capital: number; credit: number }>("select domain, capital, credit from memory_stewards where active = 1 order by domain limit 1");
  if (!state) throw new Error("No active memory steward");
  if (state.capital * state.credit * Number(store.meta("evaluator_credit")) < 0.05) return false;
  const evidence = memory ? `${nearest!.knowledge}: ${memory.raw}` : "No earlier memory is available.";
  const investment = await ask("memory-investor", `The user explicitly ordered: ${purpose}\nAvailable memory: ${evidence}\nCapital: ${state.capital}; credit: ${state.credit}. Decide whether a work proposal warrants investment. Return JSON {"fund":boolean,"expected":number,"cost":number}.`);
  if (store.purpose !== purpose || store.get<{ id: number }>("select id from log where event = 'order_changed' order by id desc limit 1")?.id !== order.id) return true;
  const expected = Number(investment.expected), cost = Number(investment.cost);
  if (typeof investment.fund !== "boolean" || !Number.isFinite(expected) || expected < 0 || !Number.isFinite(cost) || cost <= 0) throw new Error(`Invalid investment decision: ${JSON.stringify(investment).slice(0, 300)}`);
  if (!investment.fund || expected / cost < 0.05) { store.setMeta(`order_proposal:${order.id}`, "declined"); return true; }
  const evaluated = await ask("memory-evaluator", `The user explicitly ordered: ${purpose}\nAvailable memory: ${evidence}\nThis is an actionable order, not a discovery claim: do not invent corroborating evidence. Evaluate feasibility and objections and propose work to fulfil it. Return JSON {"goal":string,"score":number from 0 to 1,"objection":string}.`);
  if (store.purpose !== purpose || store.get<{ id: number }>("select id from log where event = 'order_changed' order by id desc limit 1")?.id !== order.id) return true;
  const score = Number(evaluated.score);
  if (!Number.isFinite(score) || score < 0 || score > 1 || typeof evaluated.goal !== "string") throw new Error(`Invalid order evaluation: ${JSON.stringify(evaluated).slice(0, 300)}`);
  store.tx(() => {
    let goal = "declined";
    if (score >= 0.5 && evaluated.goal && store.agents().length < store.config.maxAgents) {
      const owner = `explorer-${store.id("order").toLowerCase()}`;
      store.addAgent(owner, "Explorer who proposed this goal; own and carry it out", "host");
      goal = store.id("G");
      store.run("insert into goals(id, parent, description, status, owner, created_at) values(?, 'G0', ?, 'open', ?, ?)", goal, (evaluated.goal as string).slice(0, 1000), owner, Date.now());
      const steward = store.get<{ steward: string }>("select steward from domains where id = ?", state.domain)!;
      store.run("insert into order_stewards(goal, steward) values(?, ?)", goal, steward.steward);
    }
    store.setMeta(`order_proposal:${order.id}`, goal);
    for (const role of store.all<{ id: string; role: string }>("select id, role from market_strategies where active = 1")) {
      rewardStrategy(store, role.id, score);
      if (goal !== "declined") store.run("insert into order_strategies(goal, role, strategy) values(?, ?, ?)", goal, role.role, role.id);
    }
    store.log("memory-market", "order_proposed", { order: order.id, goal, objection: evaluated.objection });
  });
  return true;
}
