import type { Store } from "./db.ts";

export type MarketRole = "memory-investor" | "memory-evaluator";
export type Strategy = { id: string; role: MarketRole; strategy: string; capital: number; credit: number; active: number };
type Ask = (role: string, prompt: string) => Promise<Record<string, unknown>>;

export function initRoles(store: Store) {
  store.db.exec(`create table if not exists market_strategies(id text primary key, role text not null, strategy text not null, capital real not null, credit real not null, active integer not null);
    create unique index if not exists market_active_strategy on market_strategies(role) where active = 1;
    create table if not exists discovery_strategies(discovery text not null, role text not null, strategy text not null, primary key(discovery, role));
    create table if not exists order_strategies(goal text not null, role text not null, strategy text not null, primary key(goal, role));`);
  for (const [role, strategy] of [["memory-investor", "Fund proposals whose expected benefit exceeds their cost"], ["memory-evaluator", "Assess relevance, evidence and objections"]] as const) {
    if (!store.get("select 1 from market_strategies where role = ?", role)) {
      const credit = role === "memory-evaluator" ? Number(store.meta("evaluator_credit") ?? 1) : 1;
      if (!Number.isFinite(credit) || credit < 0) throw new Error("Invalid evaluator credit");
      store.run("insert into market_strategies(id, role, strategy, capital, credit, active) values(?, ?, ?, 1, ?, 1)", `${role}-1`, role, strategy, credit);
      store.run("insert into market_strategies(id, role, strategy, capital, credit, active) values(?, ?, ?, 1, 1, 0)", `${role}-2`, role, strategy);
    }
  }
}

export async function roleStrategy(store: Store, role: MarketRole, ask: Ask) {
  initRoles(store);
  const active = store.get<Strategy>("select * from market_strategies where role = ? and active = 1", role)!;
  const best = store.get<Strategy>("select * from market_strategies where role = ? and active = 0 order by capital * credit desc limit 1", role);
  if (!best || best.capital * best.credit <= active.capital * active.credit) return active;
  const result = await ask("strategy-mutator", `Improve this ${role} strategy without changing the rules of evaluation or accounting. Strategy: ${best.strategy}\nReturn JSON {"strategy":string}.`);
  if (typeof result.strategy !== "string" || !result.strategy.trim()) throw new Error("Invalid strategy mutation");
  const strategy = result.strategy.slice(0, 500);
  store.tx(() => {
    store.run("update market_strategies set active = 0 where id = ?", active.id);
    store.run("update market_strategies set active = 1, strategy = ? where id = ?", strategy, best.id);
    if (role === "memory-evaluator") store.setMeta("evaluator_credit", String(best.credit));
    store.log("memory-market", "role_strategy_replaced", { role, from: active.id, to: best.id });
  });
  return store.get<Strategy>("select * from market_strategies where id = ?", best.id)!;
}

export function rewardStrategy(store: Store, id: string, value: number) {
  store.run("update market_strategies set credit = credit * 0.8 + ? * 0.2, capital = capital * 0.8 + ? * 0.2 where id = ?", value, value, id);
  const evaluator = store.get<Strategy>("select * from market_strategies where id = ? and role = 'memory-evaluator' and active = 1", id);
  if (evaluator) store.setMeta("evaluator_credit", String(evaluator.credit));
}
