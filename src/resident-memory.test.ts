import { expect, test } from "bun:test";
import { Store } from "./db.ts";
import { distance, distanceThreshold, indexKnowledge, initMemory, remember, recordToolKnowledge, sentences, vectors, type Embed } from "./resident-memory.ts";

const embed: Embed = async text => text.includes("犬") ? [1, 0] : [0, 1];

test("resident memory preserves sentence text and stores exactly one vector and domain per fragment", async () => {
  const store = new Store(":memory:");
  initMemory(store);
  const text = "犬を飼った。\n世話をする！";
  const ids = await remember(store, embed, text, "chat:1", 1);
  expect(sentences(text).join("")).toBe(text);
  expect(sentences("\n  犬。\n\n").join("")).toBe("\n  犬。\n\n");
  expect(ids).toHaveLength(2);
  expect(vectors(store)).toHaveLength(2);
  expect(store.all<{ raw: string }>("select raw from knowledge order by rowid").map(x => x.raw).join("")).toBe(text);
  expect(store.get<{ n: number }>("select count(*) n from domain_knowledge")!.n).toBe(2);
  expect(distance([1, 0], [0, 1])).toBe(1);
  expect(distanceThreshold([0.1, 0.2, 0.4, 0.9])).toBe(0.4);
  store.db.close();
});

test("tool knowledge is embedded once and placed in the closest domain atomically", async () => {
  const store = new Store(":memory:"); initMemory(store);
  await remember(store, embed, "犬", "test");
  store.run("insert into domains(id, name, description, steward, status) values('D-z', 'z', 'z', 'z', 'active')");
  const [other] = await remember(store, embed, "猫", "test");
  store.run("update domain_knowledge set domain = 'D-z' where knowledge = ?", other);
  let calls = 0;
  await recordToolKnowledge(store, async text => { calls++; return embed(text, "passage"); }, { id: "K-tool", gist: "cat", summary: "cat", raw: "猫", source: "tool", author: "worker" });
  expect(store.get<{ domain: string }>("select domain from domain_knowledge where knowledge = 'K-tool'")!.domain).toBe("D-z");
  expect(calls).toBe(1);
  await expect(recordToolKnowledge(store, async () => { throw new Error("embed failed"); }, { id: "K-failed", gist: "x", summary: "x", raw: "x", source: "tool", author: "worker" })).rejects.toThrow("embed failed");
  expect(store.get("select 1 from knowledge where id = 'K-failed'")).toBeUndefined();
  store.db.close();
});

test("knowledge added by tools is indexed without changing its status or duplicating its content", async () => {
  const store = new Store(":memory:"); initMemory(store);
  store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values('K1', 'title', 'summary', 'raw', 'https://example.com', 'hypothesis', 'worker', 1)");
  expect(await indexKnowledge(store, embed)).toBe(true);
  expect(await indexKnowledge(store, embed)).toBe(false);
  expect(store.get<{ status: string }>("select status from knowledge where id = 'K1'")!.status).toBe("hypothesis");
  expect(vectors(store).map(v => v.knowledge)).toEqual(["K1"]);
  store.db.close();
});

test("sentences end at sentence punctuation, not at line breaks, and symbols stay with the text", () => {
  const text = "結論です。\n\n---\n\n## 1．定義\n\nRSIは自己改善です。 arxiv.org の 3.5 版を見た. 次の文";
  expect(sentences(text)).toEqual(["結論です。\n\n", "---\n\n## 1．定義\n\nRSIは自己改善です。 ", "arxiv.org の 3.5 版を見た. ", "次の文"]);
  expect(sentences("- 項目A\n- 項目B\n> 注意。")).toEqual(["- 項目A\n- 項目B\n> 注意。"]);
});
