import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { openResident, setOrder } from "./resident.ts";
import { remember, type Embed } from "./resident-memory.ts";
import { marketTick } from "./resident-market.ts";
import { initMarket } from "./resident-market.ts";

const embed: Embed = async () => [1, 0];
for (const hasMemory of [false, true]) test(`an order produces work with ${hasMemory ? "one memory" : "no memory"}`, async () => {
  const store = openResident(":memory:");
  if (hasMemory) await remember(store, embed, "existing memory", "test");
  setOrder(store, "Write the report");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  const prompts: string[] = [];
  faux.setResponses([
    ctx => { prompts.push(String(ctx.messages.find(m => m.role === "user")!.content)); return fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'); },
    fauxAssistantMessage('{"goal":"Write the report","score":0.9,"objection":"None"}'),
  ]);
  const llm = { models, model: faux.getModel() };
  expect(await marketTick(store, embed, llm)).toBe(true);
  expect(store.get<{ description: string }>("select description from goals where id != 'G0'")!.description).toBe("Write the report");
  expect(prompts[0]!.includes("existing memory")).toBe(hasMemory);
  expect(await marketTick(store, embed, llm)).toBe(false);
  store.db.close();
});

test("an order changed during evaluation cannot create stale work", async () => {
  const store = openResident(":memory:"); setOrder(store, "first");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([ctx => { setOrder(store, "second"); return fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'); }]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ n: number }>("select count(*) n from goals where id != 'G0'")!.n).toBe(0);
  store.db.close();
});

test("a dormant evaluator can replace one whose credit fell to zero", async () => {
  const store = openResident(":memory:"); setOrder(store, "work"); initMarket(store);
  store.run("update market_strategies set credit = 0 where id = 'memory-evaluator-1'");
  store.setMeta("evaluator_credit", "0");
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage('{"strategy":"check evidence"}'), fauxAssistantMessage('{"fund":true,"expected":1,"cost":1}'), fauxAssistantMessage('{"goal":"work","score":1,"objection":"none"}')]);
  expect(await marketTick(store, embed, { models, model: faux.getModel() })).toBe(true);
  expect(store.get<{ id: string }>("select id from market_strategies where role = 'memory-evaluator' and active = 1")!.id).toBe("memory-evaluator-2");
  expect(store.get<{ n: number }>("select count(*) n from goals where id != 'G0'")!.n).toBe(1);
  store.db.close();
});
