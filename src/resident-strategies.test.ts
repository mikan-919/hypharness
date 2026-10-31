import { expect, test } from "bun:test";
import { openResident } from "./resident.ts";
import { evaluateFeedback, initMarket } from "./resident-market.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { rewardSteward, transferSteward } from "./resident-stewards.ts";
import { rewardStrategy, roleStrategy, type MarketRole } from "./resident-roles.ts";

for (const role of ["memory-investor", "memory-evaluator"] as MarketRole[]) test(`${role} replaces a low-capital strategy with a mutation`, async () => {
  const store = openResident(":memory:"); initMarket(store);
  rewardStrategy(store, `${role}-1`, 0);
  let calls = 0;
  const next = await roleStrategy(store, role, async (_role, prompt) => { calls++; expect(prompt).toContain(role); return { strategy: "mutated" }; });
  expect(calls).toBe(1);
  expect(next).toMatchObject({ id: `${role}-2`, strategy: "mutated", capital: 1, credit: 1 });
  expect(store.get<{ active: number; capital: number }>("select active, capital from market_strategies where id = ?", `${role}-1`)).toEqual({ active: 0, capital: 0.8 });
  store.db.close();
});

test("existing evaluator credit is preserved when role strategies are introduced", () => {
  const store = openResident(":memory:");
  store.setMeta("evaluator_credit", "0.4");
  initMarket(store);
  expect(store.get<{ credit: number }>("select credit from market_strategies where role = 'memory-evaluator' and active = 1")!.credit).toBe(0.4);
  store.db.close();
});

test("migration keeps old balances and uses the receiving steward's original domain", () => {
  const store = openResident(":memory:");
  store.run("update memory_stewards set credit = 0.2, capital = 0.3 where domain = 'D-memory'");
  store.run("insert into domains(id, name, description, steward, status) values('D-z', 'z', 'z', 'new-owner', 'active')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) values('D-z', 'z', 0.8, 0.9, 'owner strategy')");
  store.run("update domains set steward = 'new-owner' where id = 'D-memory'");
  store.log("memory-market", "domain_transferred", { domain: "D-memory", to: "new-owner" });
  initMarket(store);
  expect(store.get("select credit, capital from memory_stewards where domain = 'D-memory'")).toEqual({ credit: 0.8, capital: 0.9 });
  expect(store.get("select credit, capital from steward_legacy_balances where domain = 'D-memory'")).toEqual({ credit: 0.2, capital: 0.3 });
  store.db.close();
});

test("user correction updates the strategies that actually funded and evaluated a discovery", async () => {
  const store = openResident(":memory:"); initMarket(store);
  store.run("insert into discoveries(id, first, second, hypothesis, objection, score, domain, created_at) values('P', 'A', 'B', 'claim', 'objection', 0.9, 'D-memory', 1)");
  for (const role of ["memory-investor", "memory-evaluator"]) store.run("insert into discovery_strategies(discovery, role, strategy) values('P', ?, ?)", role, `${role}-1`);
  store.run("insert into chat(role, text, at) values('assistant', 'claim', 1), ('user', 'incorrect', 2)");
  store.setMeta("packet:1", '["P"]');
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"used":true,"value":-1}')]);
  expect(await evaluateFeedback(store, { models, model: faux.getModel() })).toBe(true);
  for (const role of ["memory-investor", "memory-evaluator"]) expect(store.get<{ credit: number }>("select credit from market_strategies where id = ?", `${role}-1`)!.credit).toBe(0.8);
  store.db.close();
});

test("transferred domains share their owner's balance and the former owner's balance survives", () => {
  const store = openResident(":memory:"); initMarket(store);
  store.run("update memory_stewards set credit = 0.3, capital = 0.4 where domain = 'D-memory'");
  store.run("insert into domains(id, name, description, steward, status) values('D-other', 'other', 'other', 'other', 'active')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) values('D-other', 'other', 0.7, 0.8, 'other strategy')");
  store.tx(() => transferSteward(store, "D-memory", "D-other"));
  expect(store.get("select credit, capital, strategy from memory_stewards where domain = 'D-memory'")).toEqual({ credit: 0.7, capital: 0.8, strategy: "other strategy" });
  rewardSteward(store, "other", 1);
  const accounts = store.all<{ credit: number; capital: number }>("select s.credit, s.capital from memory_stewards s join domains d on d.id = s.domain where d.steward = 'other' and d.status = 'active'");
  expect(accounts).toHaveLength(2);
  expect(accounts[0]).toEqual(accounts[1]);
  expect(store.get("select s.credit, s.capital, s.active from memory_stewards s join domains d on d.id = s.domain where d.steward = 'memory-1'")).toEqual({ credit: 0.3, capital: 0.4, active: 0 });
  rewardSteward(store, "memory-1", 1);
  expect(store.get<{ capital: number }>("select s.capital from memory_stewards s join domains d on d.id = s.domain where d.steward = 'memory-1'")!.capital).toBeCloseTo(0.52);
  expect(store.get<{ capital: number }>("select capital from memory_stewards where domain = 'D-other'")!.capital).toBeCloseTo(0.84);
  store.db.close();
});
