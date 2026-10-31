import { expect, test } from "bun:test";
import { Store } from "./db.ts";
import { distance, distanceThreshold, indexKnowledge, initMemory, remember, recordToolKnowledge, paragraphs, vectors, type Embed } from "./resident-memory.ts";

const embed: Embed = async text => text.includes("犬") ? [1, 0] : [0, 1];

test("resident memory keeps one paragraph per item with exactly one vector and domain each", async () => {
  const store = new Store(":memory:");
  initMemory(store);
  const text = "犬を飼った。\n世話をする！\n\n散歩は朝。";
  const ids = await remember(store, embed, text, "chat:1", 1);
  expect(ids).toHaveLength(2);
  expect(vectors(store)).toHaveLength(2);
  expect(store.all<{ raw: string }>("select raw from knowledge order by rowid").map(x => x.raw)).toEqual(["犬を飼った。\n世話をする！", "散歩は朝。"]);
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

test("memory is a paragraph per item, labelled by its headings, without Markdown markup", () => {
  const text = "結論です。\n\n---\n\n## 1．定義\n\nRSIは自己改善です。 arxiv.org の 3.5 版を見た.\n\n### 1.1 **強い**RSI\n- 項目A\n- 項目B\n\n> **調査範囲**  \n> 検索できません。\n\n# 2．次\n本文";
  expect(paragraphs(text)).toEqual([
    { text: "結論です。", raw: "結論です。" },
    { text: "[1．定義] RSIは自己改善です。 arxiv.org の 3.5 版を見た.", raw: "RSIは自己改善です。 arxiv.org の 3.5 版を見た." },
    { text: "[1．定義 > 1.1 強いRSI] 項目A\n項目B", raw: "- 項目A\n- 項目B" },
    { text: "[1．定義 > 1.1 強いRSI] 調査範囲\n検索できません。", raw: "> **調査範囲**  \n> 検索できません。" },
    { text: "[2．次] 本文", raw: "本文" },
  ]);
  expect(paragraphs("---\n\n## 見出しだけ")).toEqual([]);
});
