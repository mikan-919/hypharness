import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openResident, setOrder } from "./resident.ts";
import { remember, type Embed } from "./resident-memory.ts";
import { evaluateFeedback, frontPacket, initMarket, marketTick, recordCompletion, rememberOrder } from "./resident-market.ts";

test("market evaluates a pair outside the window and creates a goal from an approved proposal", async () => {
  const store = openResident(":memory:");
  setOrder(store, "Help the pet");
  const embed: Embed = async text => text.includes("pet") ? [1, 0.1] : [1, 0.2];
  await remember(store, embed, "pet care.", "test:1");
  await remember(store, embed, "Dog eats food.", "test:2");
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage(JSON.stringify({ hypothesis: "The dog needs care", objection: "Food may be sufficient", score: 0.9, goal: "Prepare a care guide", mandate: "pet care", strategy: "connect needs" }))]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  const goal = store.get<{ parent: string; owner: string }>("select parent, owner from goals where id != 'G0'")!;
  expect(goal.parent).toBe("G0");
  expect(store.agent(goal.owner)).toBeDefined();
  expect(goal.owner).toStartWith("explorer-");
  expect(frontPacket(store).text).toContain("The dog needs care");
  expect(store.get<{ n: number }>("select count(*) n from usage where agent = 'memory-evaluator'")!.n).toBe(1);
  store.db.close();
});

test("orders enter memory once and remain available after the purpose changes", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "Care for the dog.");
  expect(await rememberOrder(store, embed)).toBe(true);
  expect(await rememberOrder(store, embed)).toBe(false);
  setOrder(store, "Write a guide.");
  expect(await rememberOrder(store, embed)).toBe(true);
  expect(store.get<{ n: number }>("select count(*) n from knowledge where source like 'order:%'")!.n).toBe(2);
  store.db.close();
});

test("user corrections reduce proposal and evaluator credit; completed root work is reported once", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  initMarket(store);
  setOrder(store, "Make a guide");
  const [first] = await remember(store, embed, "Dogs need walks.", "a");
  const [second] = await remember(store, embed, "A dog lives here.", "b");
  store.addAgent("worker", "worker", null);
  store.run("insert into goals(id, parent, description, status, owner, deliverable, created_at) values('G1', 'G0', 'Guide', 'done', 'worker', 'guide.txt', 1)");
  store.run("insert into discoveries(id, first, second, hypothesis, objection, score, domain, goal, created_at) values('P1', ?, ?, 'Walks help', 'Check health', 0.9, 'D-memory', 'G1', 1)", first, second);
  store.run("insert into chat(role, text, at) values('assistant', 'Walk daily', 1)");
  store.setMeta("packet:1", JSON.stringify(["P1"]));
  store.run("insert into chat(role, text, at) values('user', 'That is wrong', 2)");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"used":true,"value":-1}'), fauxAssistantMessage('{"report":"Guide completed: guide.txt"}')]);
  const llm = { models, model: faux.getModel() };
  expect(await evaluateFeedback(store, llm)).toBe(true);
  expect(Number(store.meta("evaluator_credit"))).toBeLessThan(1);
  expect(store.get<{ score: number }>("select score from discoveries where id = 'P1'")!.score).toBeLessThan(0.9);
  expect(await recordCompletion(store, embed, llm)).toBe(true);
  expect(await recordCompletion(store, embed, llm)).toBe(false);
  expect(store.get<{ n: number }>("select count(*) n from chat where text = 'Guide completed: guide.txt'")!.n).toBe(1);
  expect(store.get<{ n: number }>("select count(*) n from knowledge where source like 'goal:G1%'")!.n).toBeGreaterThan(0);
  store.db.close();
});

test("a steward chooses whether to split and every memory keeps one domain", async () => {
  const store = openResident(":memory:"); setOrder(store, "care");
  const samples: Record<string, number[]> = { a: [1, 0], b: [0.9, 0.1], c: [0, 1], d: [-1, 0] };
  const embed: Embed = async (text, kind) => kind === "query" ? [1, 0] : samples[text] ?? [1, 0];
  for (const text of Object.keys(samples)) await remember(store, embed, text, "sample");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage('{"hypothesis":"two facts","objection":"uncertain","score":0.8,"goal":""}'), fauxAssistantMessage('{"action":"split","new_strategy":"seek other links"}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ n: number }>("select count(*) n from domains where status = 'active'")!.n).toBe(2);
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge")!.n).toBe(4);
  expect(store.get<{ n: number }>("select count(distinct knowledge) n from domain_knowledge")!.n).toBe(4);
  expect(store.get<{ capital: number }>("select capital from memory_stewards where domain = 'D-memory'")!.capital).toBeCloseTo(0.96);
  expect(store.get<{ capital: number }>("select capital from memory_stewards where domain != 'D-memory' and active = 1")!.capital).toBe(1);
  store.db.close();
});

test("merging domains preserves each steward's balance and transfers the memories", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care"); initMarket(store);
  await remember(store, embed, "first", "a"); await remember(store, embed, "second", "b");
  const [third] = await remember(store, embed, "third", "c");
  store.run("insert into domains(id, name, description, steward, status) values('D-other', 'Other', 'Other', 'other', 'active')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) values('D-other', 'other', 0.3, 0.4, 'other')");
  store.run("update domain_knowledge set domain = 'D-other' where knowledge = ?", third);
  store.run("insert into domain_requests(source, target, kind) values('D-other', 'D-memory', 'merge')");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage('{"hypothesis":"two facts","objection":"uncertain","score":0.8,"goal":""}'), fauxAssistantMessage('{"action":"accept_request"}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get("select credit, capital, active from memory_stewards where domain = 'D-other'")).toEqual({ credit: 0.3, capital: 0.4, active: 0 });
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge where domain = 'D-memory'")!.n).toBe(3);
  expect(store.get<{ capital: number }>("select capital from memory_stewards where domain = 'D-memory'")!.capital).toBeCloseTo(0.96);
  store.db.close();
});

test("market rejects a semantically duplicate pair before calling the evaluator", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care"); initMarket(store);
  const [a] = await remember(store, embed, "one", "a");
  const [b] = await remember(store, embed, "two", "b");
  await remember(store, embed, "three", "c");
  store.run("insert into discoveries(id, first, second, hypothesis, objection, score, domain, created_at) values('P1', ?, ?, 'known', 'none', 0.8, 'D-memory', 1)", a, b);
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(false);
  expect(store.get<{ n: number }>("select count(*) n from usage")!.n).toBe(0);
  store.db.close();
});

test("investor rejects a proposal below its benefit-to-cost floor", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care");
  await remember(store, embed, "one", "a"); await remember(store, embed, "two", "b");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":0.01,"cost":1}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ n: number }>("select count(*) n from discoveries")!.n).toBe(0);
  expect(store.get<{ n: number }>("select count(*) n from usage where agent = 'memory-evaluator'")!.n).toBe(0);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(false);
  store.db.close();
});

test("low evaluator credit reduces the value available for investment", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care"); initMarket(store);
  await remember(store, embed, "one", "a"); await remember(store, embed, "two", "b");
  store.setMeta("evaluator_credit", "0");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(false);
  expect(store.get<{ n: number }>("select count(*) n from usage")!.n).toBe(0);
  store.db.close();
});

test("a transfer changes stewardship only after the current steward accepts", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care"); initMarket(store);
  await remember(store, embed, "one", "a"); await remember(store, embed, "two", "b");
  store.run("insert into domains(id, name, description, steward, status) values('D-other', 'Other', 'Other', 'other-steward', 'active')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) values('D-other', 'other', 1, 1, 'other')");
  store.run("insert into domain_requests(source, target, kind) values('D-other', 'D-memory', 'transfer')");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage('{"hypothesis":"two facts","objection":"uncertain","score":0.8,"goal":""}'), fauxAssistantMessage('{"action":"accept_request"}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ steward: string }>("select steward from domains where id = 'D-memory'")!.steward).toBe("other-steward");
  expect(store.get<{ status: string }>("select status from domain_requests")!.status).toBe("accepted");
  store.db.close();
});

test("a dormant steward can replace a low-capital strategy with a mutation", async () => {
  const store = openResident(":memory:"), embed: Embed = async () => [1, 0];
  setOrder(store, "care"); initMarket(store);
  await remember(store, embed, "one", "a"); await remember(store, embed, "two", "b");
  store.run("update memory_stewards set capital = 0.2 where domain = 'D-memory'");
  store.run("insert into domains(id, name, description, steward, status) values('D-extra', 'Extra', 'Extra', 'memory-1', 'active')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) select 'D-extra', mandate, credit, capital, strategy from memory_stewards where domain = 'D-memory'");
  store.run("insert into domains(id, name, description, steward, status) values('D-strong', 'Strong', 'Strong', 'strong', 'active'), ('D-sleep', 'Sleep', 'Sleep', 'sleeping', 'merged')");
  store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy, active) values('D-strong', 'strong', 1, 2, 'strong strategy', 1), ('D-sleep', 'old', 0.5, 0.1, 'old strategy', 0)");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage('{"hypothesis":"two facts","objection":"uncertain","score":0.8,"goal":""}'), fauxAssistantMessage('{"action":"replace_strategy","new_strategy":"mutated strong strategy"}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ steward: string }>("select steward from domains where id = 'D-memory'")!.steward).toBe("sleeping");
  expect(store.get<{ strategy: string }>("select strategy from memory_stewards where domain = 'D-memory'")!.strategy).toBe("mutated strong strategy");
  expect(store.get<{ steward: string }>("select steward from domains where id = 'D-extra'")!.steward).toBe("sleeping");
  expect(store.get("select credit, capital from memory_stewards where domain = 'D-extra'")).toEqual(store.get("select credit, capital from memory_stewards where domain = 'D-memory'"));
  expect(store.get<{ active: number }>("select active from memory_stewards where domain = 'D-sleep'")!.active).toBe(0);
  store.db.close();
});
