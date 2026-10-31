import type { Store } from "./db.ts";

export type Embed = (text: string, kind: "query" | "passage") => Promise<number[]>;

// The model is loaded only by the resident process, never by tests or benchmark stores.
export function localEmbed(): Embed {
  let model: Promise<import("@huggingface/transformers").FeatureExtractionPipeline> | undefined;
  return async (text, kind) => {
    const { pipeline } = await import("@huggingface/transformers");
    model ??= pipeline("feature-extraction", "Xenova/multilingual-e5-small", { dtype: "q8" });
    const output = await (await model)(`${kind}: ${text}`, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
  };
}

export function distance(a: number[], b: number[]) {
  if (!a.length || a.length !== b.length) throw new Error("Invalid embedding dimensions");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  if (!aa || !bb) throw new Error("Zero embedding");
  return 1 - dot / Math.sqrt(aa * bb);
}

// A sentence ends at 。！？!? or at a full stop followed by a space; a line break does not end one, so Markdown headings,
// rules and list markers stay with the text after them. A piece with no letter or digit joins its neighbour.
// The pieces keep every character: joined, they are the text.
export function sentences(text: string) {
  const out: string[] = [];
  for (const piece of text.match(/.*?(?:[。！？!?]+|\.(?=\s|$))\s*|.+/gsu) ?? []) {
    if (out.length && (!/[\p{L}\p{N}]/u.test(piece) || !/[\p{L}\p{N}]/u.test(out.at(-1)!))) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out;
}

export function initMemory(store: Store) {
  store.db.exec(`
    create table if not exists memory_vectors(knowledge text primary key, vector text not null, chat_id integer);
    create table if not exists memory_stewards(domain text primary key, mandate text not null, credit real not null, capital real not null, strategy text not null, active integer not null default 1);
    create unique index if not exists memory_one_domain on domain_knowledge(knowledge);
  `);
  if (!store.get("select 1 from domains where id = 'D-memory'")) store.tx(() => {
    store.run("insert into domains(id, name, description, steward, status) values('D-memory', 'Memory', 'Conversation and results', 'memory-1', 'active')");
    store.run("insert into memory_stewards(domain, mandate, credit, capital, strategy) values('D-memory', 'Organize conversation and results', 1, 1, 'Seek useful connections')");
  });
}

type MemoryRow = { knowledge: string; vector: string; domain: string };
export function vectors(store: Store) {
  return store.all<MemoryRow>("select v.knowledge, v.vector, d.domain from memory_vectors v join domain_knowledge d on d.knowledge = v.knowledge").map(r => ({ ...r, vector: JSON.parse(r.vector) as number[] }));
}

function nearestDomain(store: Store, vector: number[]) {
  const nearest = vectors(store).map(v => ({ domain: v.domain, d: distance(vector, v.vector) })).sort((a, b) => a.d - b.d)[0];
  return nearest?.domain ?? store.get<{ id: string }>("select id from domains where status = 'active' order by id limit 1")?.id ?? (() => { throw new Error("No active memory domain"); })();
}

export async function recordToolKnowledge(store: Store, embed: Embed, item: { id: string; gist: string; summary: string; raw: string; source: string; author: string; dedupeSource?: boolean }) {
  const vector = await embed(item.raw, "passage");
  return store.tx(() => {
    if (item.dedupeSource) {
      const existing = store.get<{ id: string }>("select id from knowledge where source = ?", item.source);
      if (existing) return existing.id;
    }
    const domain = nearestDomain(store, vector);
    store.run("insert into knowledge(id, gist, summary, raw, source, status, author, created_at) values(?, ?, ?, ?, ?, 'hypothesis', ?, ?)", item.id, item.gist, item.summary, item.raw, item.source, item.author, Date.now());
    store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain, item.id);
    store.run("insert into memory_vectors(knowledge, vector) values(?, ?)", item.id, JSON.stringify(vector));
    store.log(item.author, "knowledge_added", { id: item.id, gist: item.gist });
    return item.id;
  });
}

// Quantiles adapt to each domain instead of assuming a model-specific distance scale.
export function distanceThreshold(values: number[], quantile = 0.75) {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * quantile)]!;
}

// What the user said, or an order, is a verified record; an assistant's reply is only a hypothesis until checked.
export async function remember(store: Store, embed: Embed, text: string, source: string, chatId?: number, status: "verified" | "hypothesis" = "verified") {
  const pieces = sentences(text);
  const embeddings = await Promise.all(pieces.map(piece => embed(piece, "passage")));
  return store.tx(() => {
    const ids: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i]!, vector = embeddings[i]!, domain = nearestDomain(store, vector), id = store.id("K");
      store.run("insert into knowledge(id, gist, summary, raw, source, status, author, verified_by, created_at) values(?, ?, ?, ?, ?, ?, 'ingest', ?, ?)", id, piece, piece, piece, source, status, status === "verified" ? "ingest" : null, Date.now());
      store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain, id);
      store.run("insert into memory_vectors(knowledge, vector, chat_id) values(?, ?, ?)", id, JSON.stringify(vector), chatId ?? null);
      ids.push(id);
    }
    return ids;
  });
}

export async function indexKnowledge(store: Store, embed: Embed) {
  const item = store.get<{ id: string; raw: string }>("select id, raw from knowledge where id not in (select knowledge from memory_vectors) order by created_at limit 1");
  if (!item) return false;
  const vector = await embed(item.raw, "passage");
  store.tx(() => {
    if (store.get("select 1 from memory_vectors where knowledge = ?", item.id)) return;
    const domain = nearestDomain(store, vector);
    const assigned = store.get("select 1 from domain_knowledge where knowledge = ?", item.id);
    if (assigned) store.run("update domain_knowledge set domain = ? where knowledge = ?", domain, item.id);
    else store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain, item.id);
    store.run("insert into memory_vectors(knowledge, vector) values(?, ?)", item.id, JSON.stringify(vector));
  });
  return true;
}
