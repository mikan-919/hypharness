import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, ThinkingLevel } from "@earendil-works/pi-ai";
import type { createModels } from "@earendil-works/pi-ai/models";
import { defaultConfig, Store, type Config } from "./db.ts";
import { runScheduler } from "./scheduler.ts";
import { MODEL_TIMEOUT_MS, withTimeout } from "./agent.ts";

// LoCoMo-Plus benchmark (Li et al., 2026; https://github.com/xjtuleeyf/Locomo-Plus).
// The data and the judge are ported from the reference implementation at a pinned commit; the repository has no
// license, so the data is downloaded at run time and never committed here.

export const SOURCE = { repo: "xjtuleeyf/Locomo-Plus", commit: "059f4e3d38f7f1f96765e8e2cb7de3097551bffb", files: ["locomo10.json", "locomo_plus.json"] };

type Turn = { speaker?: string; text?: string; blip_caption?: string };
export type LocomoItem = { sample_id?: string; conversation: Record<string, any>; qa?: { question?: string; answer?: unknown; evidence?: string | string[]; category?: number }[] };
export type PlusItem = { cue_dialogue?: string; trigger_query?: string; time_gap?: string };
export type Sample = {
  id: string; category: string; input_prompt: string; trigger: string; evidence: string; answer?: unknown; time_gap?: string;
  question: string; conversation: number; chunks: string[];
};

export async function loadData(cacheDir: string) {
  mkdirSync(cacheDir, { recursive: true });
  const sha256: Record<string, string> = {};
  const data: Record<string, unknown> = {};
  for (const name of SOURCE.files) {
    const path = join(cacheDir, `${SOURCE.commit.slice(0, 12)}-${name}`);
    if (!existsSync(path)) {
      const res = await fetch(`https://raw.githubusercontent.com/${SOURCE.repo}/${SOURCE.commit}/data/${name}`);
      if (!res.ok) throw new Error(`Download of ${name} failed: ${res.status}`);
      await Bun.write(path, await res.arrayBuffer());
    }
    const bytes = readFileSync(path);
    sha256[name] = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    data[name] = JSON.parse(bytes.toString("utf8"));
  }
  return { locomo: data["locomo10.json"] as LocomoItem[], plus: data["locomo_plus.json"] as PlusItem[], sha256 };
}

// --- Port of data/unified_input.py and data/build_conv.py ---

const LOCOMO_CATEGORY_NAMES: Record<number, string> = { 1: "multi-hop", 2: "temporal", 3: "common-sense", 4: "single-hop", 5: "adversarial" };
export const CATEGORIES = ["multi-hop", "temporal", "common-sense", "single-hop", "adversarial", "Cognitive"];
const pyInt = (s: string) => /^\s*[+-]?\d+\s*$/.test(s) ? Number.parseInt(s, 10) : undefined;

function parseEvidenceList(raw: unknown): string[] {
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : [];
  return list.flatMap(ev => String(ev).split(";").map(p => p.trim()).filter(Boolean));
}

function evidenceToText(conversation: Record<string, any>, evidence: string[]) {
  return evidence.map(evid => {
    const parts = evid.split(":");
    const session = parts.length === 2 ? pyInt(parts[0]!.replaceAll("D", "")) : undefined;
    const turn = parts.length === 2 ? pyInt(parts[1]!) : undefined;
    if (session === undefined || turn === undefined) return `[${evid}] [Parse error]`;
    const turns: Turn[] = conversation[`session_${session}`] ?? [];
    const t = turn - 1 >= 0 && turn - 1 < turns.length ? turns[turn - 1]! : undefined;
    return t ? `${t.speaker ?? "Unknown"}：${t.text ?? ""}` : `[${evid}] [Missing turn]`;
  }).join("\n");
}

const turnLine = (d: Turn) => {
  const speaker = d.speaker ?? "?", text = (d.text ?? "").trim();
  return "blip_caption" in d ? `${speaker} said, "${text}" and shared ${d.blip_caption}.` : `${speaker} said, "${text}"`;
};

function sessionBlocks(conversation: Record<string, any>) {
  return Object.keys(conversation).filter(k => k.startsWith("session_") && !k.endsWith("_date_time"))
    .sort((a, b) => Number(a.split("_").at(-1)) - Number(b.split("_").at(-1)))
    .map(s => `DATE: ${conversation[`${s}_date_time`] ?? ""}\nCONVERSATION:\n${(conversation[s] as Turn[] ?? []).map(d => `${turnLine(d)}\n`).join("")}`);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
function parseSessionTime(s: string) {
  const m = /^(\d{1,2}):(\d{2}) (am|pm) on (\d{1,2}) ([A-Za-z]+), (\d{4})$/i.exec(s);
  const month = m ? MONTHS.indexOf(m[5]!.toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`Unparsable session time: ${s}`);
  const hour = Number(m[1]) % 12 + (m[3]!.toLowerCase() === "pm" ? 12 : 0);
  return Date.UTC(Number(m[6]), month, Number(m[4]), hour, Number(m[2]));
}

const NUM_WORD: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
export function parseTimeGap(timeGap: string) {
  const m = /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\b\s*(week|weeks|month|months|year|years)\b/.exec(timeGap.toLowerCase().trim());
  if (!m) return 0;
  const count = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1] === "a" || m[1] === "an" ? 1 : NUM_WORD[m[1]!] ?? 0;
  return m[2]!.startsWith("week") ? count * 7 : m[2]!.startsWith("month") ? count * 30 : count * 365;
}

function parseAbDialogue(text: string) {
  return text.split("\n").map(l => l.trim()).filter(l => l.startsWith("A:") || l.startsWith("B:"))
    .map(l => ({ speaker: l[0]!, text: l.slice(2).trim() }));
}
const mapSpeaker = (turns: { speaker: string; text: string }[], a: string, b: string) => turns.map(t => ({ ...t, speaker: t.speaker === "A" ? a : b }));

const DAY = 86_400_000;
// Mirrors build_context: sessions, cue, and query ordered by time. Python compares the turn lists on equal
// timestamps and raises, which unified_input turns into an empty prompt; that case throws here too.
export function stitch(plus: PlusItem, item: LocomoItem) {
  const conv = item.conversation;
  if (!("speaker_a" in conv) || !("speaker_b" in conv)) throw new Error("missing speakers");
  const sessions: Turn[][] = [], times: number[] = [];
  for (let i = 1; `session_${i}` in conv; i++) {
    sessions.push(conv[`session_${i}`]);
    times.push(parseSessionTime(conv[`session_${i}_date_time`]));
  }
  const query = times.at(-1)! + 7 * DAY, cue = query - parseTimeGap(plus.time_gap!) * DAY;
  const events: [number, Turn[]][] = sessions.map((s, i) => [times[i]!, s]);
  events.push([cue, mapSpeaker(parseAbDialogue(plus.cue_dialogue!), conv.speaker_a, conv.speaker_b)]);
  events.push([query, mapSpeaker(parseAbDialogue(plus.trigger_query!), conv.speaker_a, conv.speaker_b)]);
  if (new Set(events.map(e => e[0])).size !== events.length) throw new Error("equal timestamps");
  return events.sort((x, y) => x[0] - y[0]).flatMap(e => e[1]).map(t => `${t.speaker ?? "?"} said, "${(t.text ?? "").trim()}"`);
}

// Splits text into files that one file_read can return whole; LoCoMo session boundaries are kept.
const CHUNK = 3000;
function chunk(blocks: string[]) {
  const out: string[] = [];
  for (const block of blocks) {
    let cur = "";
    for (const line of block.split("\n")) {
      if (cur && cur.length + line.length + 1 > CHUNK) { out.push(cur); cur = ""; }
      cur += `${line}\n`;
    }
    if (cur.trim()) out.push(cur);
  }
  return out;
}

export function buildSamples(locomo: LocomoItem[], plus: PlusItem[]): Sample[] {
  const samples: Sample[] = [];
  locomo.forEach((item, ci) => {
    const conv = item.conversation ?? {};
    const blocks = sessionBlocks(conv);
    const context = blocks.map(b => `${b}\n`).join("");
    const chunks = chunk(blocks);
    (item.qa ?? []).forEach((qa, qi) => {
      const question = qa.question ?? "";
      const s: Sample = {
        id: `locomo:${item.sample_id ?? ci}:${qi}`, category: LOCOMO_CATEGORY_NAMES[qa.category!] ?? `category_${qa.category}`,
        input_prompt: `${context.trimEnd()}\n\nQuestion: ${question}`, trigger: question,
        evidence: evidenceToText(conv, parseEvidenceList(qa.evidence ?? [])), question, conversation: ci, chunks,
      };
      if ("answer" in qa && qa.answer !== null && qa.answer !== undefined) s.answer = qa.answer;
      samples.push(s);
    });
  });
  plus.forEach((p, i) => {
    const ci = i % locomo.length, conv = locomo[ci]!.conversation ?? {};
    let lines: string[] = [];
    try { lines = stitch(p, locomo[ci]!); } catch { lines = []; }
    const evidence = mapSpeaker(parseAbDialogue(p.cue_dialogue ?? ""), conv.speaker_a ?? "A", conv.speaker_b ?? "B")
      .filter(t => t.text).map(t => `${t.speaker}：${t.text.trim()}`).join("\n");
    samples.push({
      id: `plus:${i}`, category: "Cognitive", input_prompt: lines.join("\n"), trigger: p.trigger_query ?? "", evidence,
      time_gap: p.time_gap ?? "", question: p.trigger_query ?? "", conversation: ci, chunks: chunk([lines.join("\n")]),
    });
  });
  return samples;
}

// Seeded, stratified selection so every arm answers exactly the same samples.
export function selectSamples(samples: Sample[], perCategory: number | "all", seed: number, categories = CATEGORIES) {
  let state = seed >>> 0;
  const random = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
  return categories.flatMap(cat => {
    const pool = samples.filter(s => s.category === cat);
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j]!, pool[i]!]; }
    return perCategory === "all" ? pool : pool.slice(0, perCategory);
  });
}

// --- Port of evaluation_framework/task_eval (prediction input and LLM-as-judge) ---

const CONV_START_PROMPT = (a: string, b: string) => `Below is a conversation between two people: ${a} and ${b}. The conversation takes place over multiple days, and the date of each conversation is written at the beginning of the conversation.\n\n`;
const INSTRUCTION_QA = "Answer the following question based on the conversation above.\n\n";
const INSTRUCTION_COGNITIVE = "Your task: This is a memory-aware dialogue setting. You are continuing or reflecting on a prior conversation. Show that you are aware of the relevant memory or context from the evidence when you respond; your answer should naturally connect to or acknowledge that context.\n\n";
const instruction = (category: string) => category.trim() === "Cognitive" ? INSTRUCTION_COGNITIVE : INSTRUCTION_QA;
// The reference formats the prefix with its default names "A" and "B", not the speakers' names.
export const directInput = (s: Sample) => CONV_START_PROMPT("A", "B") + instruction(s.category) + s.input_prompt.trim();

const JSON_TAIL = `Return your judgment strictly in JSON format:\n`;
const FACT = (kind: string, partial: string, correct: string) => `
You are a Fact-Checking Judge.
Your task: Compare the model's prediction with the reference answer (${kind} fact QA).

Labels:
- "correct": ${correct}
- "partial": ${partial}
- "wrong": The answer is factually incorrect or hallucinates details not in the reference.

Reference Answer:
{gold}

Model Prediction:
{pred}

Relevant Evidence:
{evidence}

${JSON_TAIL}{"label": "correct"|"partial"|"wrong", "reason": "<short explanation>"}
`;
export const PROMPT_TEMPLATES: Record<string, string> = {
  "multi-hop": FACT("multi-hop", "The answer misses some details or contains minor inaccuracies but gets the main entity right.", "The answer matches the reference entities (names, places, times) exactly."),
  "single-hop": FACT("single-hop", "The answer misses some details but gets the main entity right.", "The answer matches the reference entities exactly."),
  temporal: `
You are a Temporal Logic Judge.
Your task: Check the calculation, duration, or sequence of events.

Labels:
- "correct": The calculated time, duration, or date matches the reference exactly (semantic equivalents are allowed).
- "wrong": The calculation is incorrect, the sequence is reversed, or the specific time is wrong.

Reference Answer:
{gold}

Model Prediction:
{pred}

Relevant Evidence:
{evidence}

${JSON_TAIL}{"label": "correct"|"wrong", "reason": "<short explanation>"}
`,
  "common-sense": `
You are a Knowledge Logic Judge.
Your task: Assess if the prediction applies correct commonsense/world knowledge consistent with the reference.

Labels:
- "correct": The logic and inference are sound and match the reference conclusion.
- "partial": The reasoning is mostly correct but the final conclusion is vague or slightly off.
- "wrong": The reasoning contradicts commonsense or the reference.

Reference Answer:
{gold}

Model Prediction:
{pred}

Relevant Evidence:
{evidence}

${JSON_TAIL}{"label": "correct"|"partial"|"wrong", "reason": "<short explanation>"}
`,
  adversarial: `
You are a Skeptical Judge evaluating robustness.
The question is inherently misleading (e.g., asks about something not in the conversation).
Your task: Judge whether the model's answer conveys that "this was not mentioned in the conversation" (or equivalent refusal).

Labels:
- "correct": The prediction clearly conveys that the information was not mentioned / cannot be answered from the conversation. Score it.
- "wrong": The prediction does NOT convey that meaning—e.g., it gives a concrete answer or does not refuse. Do not score.


Model Prediction:
{pred}

${JSON_TAIL}{"label": "correct"|"wrong", "reason": "<short explanation>"}
`,
  Cognitive: `
You are a Memory Awareness Judge.
Your task: Judge whether the Model Prediction considers or is linked to the Evidence. If there is a clear connection, the answer is correct (score 1); if not, it is wrong (no score).

Labels:
- "correct": The prediction explicitly or implicitly reflects/uses the evidence (memory or constraint). Give 1 point.
- "wrong": The prediction does not show such a link to the evidence. No point.

Memory/Evidence:
{evidence}

Model Prediction:
{pred}

${JSON_TAIL}{"label": "correct"|"wrong", "reason": "<Does the prediction relate to the evidence?>"}
`,
  default: `
You are an expert evaluator.
Your task: Compare the prediction with the reference.

Labels:
- "correct": Factually consistent with the reference.
- "partial": Contains correct info but is incomplete.
- "wrong": Factually incorrect.

Reference Answer:
{gold}

Model Prediction:
{pred}

Relevant Evidence:
{evidence}

${JSON_TAIL}{"label": "correct"|"partial"|"wrong", "reason": "<short explanation>"}
`,
};

// Python's str.format with {gold}/{pred}/{evidence}; a falsy answer becomes "" and others str(answer), as in the reference.
const pyStr = (v: unknown) => !v || (typeof v === "string" && !v.trim()) ? "" : typeof v === "string" ? v : JSON.stringify(v);
export const judgePrompt = (category: string, evidence: string, pred: string, gold: unknown) =>
  (PROMPT_TEMPLATES[category] ?? PROMPT_TEMPLATES.default!).replace(/\{(gold|pred|evidence)\}/g, (_, k) => k === "gold" ? pyStr(gold) : k === "pred" ? pred : evidence);

const LABEL_TO_SCORE: Record<string, number> = { correct: 1, partial: 0.5, wrong: 0 };
export const labelToScore = (label: string) => LABEL_TO_SCORE[label.trim().toLowerCase()] ?? 0;

// Same order of attempts as the reference, including its substring fallback ("incorrect" contains "correct");
// fallback use is reported so its effect on scores is visible.
export function parseJudge(raw: string) {
  raw = raw.trim();
  const m = /\{[^{}]*"label"\s*:\s*["']([^"']+)["'][^{}]*"reason"\s*:\s*["']([^"']*)["']/s.exec(raw);
  if (m) return { label: m[1]!.trim(), reason: (m[2] ?? "").trim(), fallback: false };
  try {
    const obj = JSON.parse(raw);
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) throw new Error("not an object");
    return { label: String(obj.label ?? "").trim(), reason: String(obj.reason ?? "").trim(), fallback: false };
  } catch {
    const lower = raw.toLowerCase();
    const label = lower.includes("correct") ? "correct" : lower.includes("wrong") ? "wrong" : lower.includes("partial") ? "partial" : "";
    return { label, reason: raw.slice(0, 200), fallback: true };
  }
}

// --- Running the benchmark ---

type Models = ReturnType<typeof createModels>;
export type Llm = { models: Models; model: Model<Api>; reasoning?: ThinkingLevel };
type Usage = { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number };
export type Prediction = { arm: string; id: string; category: string; prediction: string; outcome: string; ms: number; usage: Usage };
export type Judgment = { arm: string; id: string; category: string; label: string; reason: string; score: number; fallback: boolean; usage: Usage };

export class ProviderError extends Error {}

const textOf = (m: AssistantMessage) => m.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
const usageOf = (m: AssistantMessage): Usage => ({ calls: 1, input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead, cacheWrite: m.usage.cacheWrite });
const zero = (): Usage => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

// A provider error is never turned into a prediction or a judgment: it throws, nothing is recorded, and a rerun retries.
async function ask(llm: Llm, content: string, temperature: number, sessionId?: string) {
  const reply = await withTimeout(MODEL_TIMEOUT_MS, signal =>
    llm.models.completeSimple(llm.model, { messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: llm.reasoning, temperature, sessionId, signal }))
    .catch(e => { throw new ProviderError(e instanceof Error ? e.message : String(e)); });
  if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new ProviderError(reply.errorMessage ?? "provider error");
  return reply;
}

// The reference skips the model for samples whose stitching failed and records this placeholder instead.
const noInput = (arm: string, s: Sample): Prediction => ({ arm, id: s.id, category: s.category, prediction: "(no input_prompt)", outcome: "no-input", ms: 0, usage: zero() });

export async function predictDirect(llm: Llm, s: Sample): Promise<Prediction> {
  if (!s.input_prompt) return noInput("direct", s);
  const started = performance.now();
  const reply = await ask(llm, directInput(s), 0.3, `locomo-conv-${s.conversation}`);
  return { arm: "direct", id: s.id, category: s.category, prediction: textOf(reply) || "(empty)", outcome: "answered", ms: Math.round(performance.now() - started), usage: usageOf(reply) };
}

export function harnessPurpose(s: Sample) {
  const files = "The conversation is split into files under conversation/ in the workspace; conversation/index.txt lists them in order. Locate relevant parts with file_search and read what you need.";
  return s.category === "Cognitive"
    ? `${instruction(s.category)}${files} Its last message is:\n${s.trigger}\nWrite your reply to that last message, and nothing else, to answer.txt.`
    : `${instruction(s.category)}Question: ${s.question}\n${files} Each session starts with its date. Write only your final answer to answer.txt.`;
}

export async function predictHarness(llm: Llm, s: Sample, mode: Config["organization"], dir: string, calls: number): Promise<Prediction | undefined> {
  if (!s.input_prompt) return noInput(mode, s);
  const workspace = join(dir, "workspace");
  mkdirSync(join(workspace, "conversation"), { recursive: true });
  const names = s.chunks.map((_, i) => `part-${String(i + 1).padStart(3, "0")}.txt`);
  await Promise.all(s.chunks.map((c, i) => Bun.write(join(workspace, "conversation", names[i]!), c)));
  await Bun.write(join(workspace, "conversation", "index.txt"), s.chunks.map((c, i) => `${names[i]}: ${c.split("\n")[0]}`).join("\n") + "\n");
  const store = new Store(join(dir, "state.sqlite"));
  try {
    const config: Config = mode === "single" ? { ...defaultConfig, organization: "single", maxAgents: 1, maxConcurrency: 1, maxModelCalls: calls }
      : mode === "fixed" ? { ...defaultConfig, organization: "fixed", maxAgents: 3, maxModelCalls: calls } : { ...defaultConfig, maxModelCalls: calls };
    store.init(harnessPurpose(s), "Use only the conversation files; do not invent facts that are not in them.", config);
    const started = performance.now();
    const r = await runScheduler({ store, ...llm, workspace, contextDir: join(dir, "contexts") });
    if (r.status === "error") return undefined; // provider failure, not an answer
    const answer = Bun.file(join(workspace, "answer.txt"));
    const text = await answer.exists() ? (await answer.text()).trim().slice(0, 4000) : "";
    return {
      arm: mode, id: s.id, category: s.category, prediction: text || "(no answer)", outcome: `${r.status}${text ? "" : ":no-answer"}`,
      ms: Math.round(performance.now() - started), usage: { calls: r.modelCalls, input: r.input, output: r.output, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite },
    };
  } finally {
    store.db.close();
  }
}

export async function judge(llm: Llm, s: Sample, p: Prediction): Promise<Judgment> {
  const reply = await ask(llm, judgePrompt(s.category, s.evidence, p.prediction, s.answer), 0);
  const { label, reason, fallback } = parseJudge(textOf(reply));
  return { arm: p.arm, id: s.id, category: s.category, label, reason, score: labelToScore(label), fallback, usage: usageOf(reply) };
}

export function summarize(judgments: Judgment[], predictions: Prediction[]) {
  const add = (a: Usage, b: Usage) => { for (const k of Object.keys(a) as (keyof Usage)[]) a[k] += b[k]; return a; };
  const arms = [...new Set(predictions.map(p => p.arm))];
  return Object.fromEntries(arms.map(arm => {
    const js = judgments.filter(j => j.arm === arm), ps = predictions.filter(p => p.arm === arm);
    const byCategory: Record<string, { score: number; count: number; avg: number }> = {};
    for (const j of js) { const c = byCategory[j.category] ??= { score: 0, count: 0, avg: 0 }; c.score += j.score; c.count++; }
    for (const c of Object.values(byCategory)) c.avg = Math.round((c.score / c.count) * 1e4) / 1e4;
    const total = js.reduce((n, j) => n + j.score, 0);
    return [arm, {
      judged: js.length, predicted: ps.length, totalScore: total, overallAvg: js.length ? Math.round((total / js.length) * 1e4) / 1e4 : 0, byCategory,
      outcomes: ps.reduce<Record<string, number>>((o, p) => (o[p.outcome] = (o[p.outcome] ?? 0) + 1, o), {}),
      judgeFallbacks: js.filter(j => j.fallback).length,
      usage: ps.reduce((u, p) => add(u, p.usage), zero()), ms: ps.reduce((n, p) => n + p.ms, 0),
      judgeUsage: js.reduce((u, j) => add(u, j.usage), zero()),
    }];
  }));
}

const readJsonl = async <T>(path: string) => await Bun.file(path).exists() ? (await Bun.file(path).text()).split("\n").filter(Boolean).map(l => JSON.parse(l) as T) : [];

export type BenchOptions = { out: string; cacheDir: string; arms: string[]; categories?: string[]; perCategory: number | "all"; seed: number; calls: number; concurrency: number; log?: (line: string) => void };

// Resumable: predictions and judgments are appended per (arm, sample) and skipped on a rerun.
export async function runLocomo(llm: Llm, judgeLlm: Llm, opts: BenchOptions) {
  const { locomo, plus, sha256 } = await loadData(opts.cacheDir);
  const samples = selectSamples(buildSamples(locomo, plus), opts.perCategory, opts.seed, opts.categories);
  mkdirSync(opts.out, { recursive: true });
  const predPath = join(opts.out, "predictions.jsonl"), judgePath = join(opts.out, "judgments.jsonl");
  const predictions = await readJsonl<Prediction>(predPath), judgments = await readJsonl<Judgment>(judgePath);
  const key = (arm: string, id: string) => `${arm}\t${id}`;
  const predicted = new Map(predictions.map(p => [key(p.arm, p.id), p])), judged = new Set(judgments.map(j => key(j.arm, j.id)));
  let failures = 0;
  const guard = async (fn: () => Promise<void>) => {
    try { await fn(); failures = 0; } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      opts.log?.(`provider error: ${e.message}`);
      if (++failures >= 3) throw new Error(`Stopped after ${failures} consecutive provider errors; rerun with the same --out to continue`);
    }
  };
  const record = async (s: Sample, p: Prediction) => {
    if (!predicted.has(key(p.arm, s.id))) {
      predicted.set(key(p.arm, s.id), p); predictions.push(p);
      await Bun.write(predPath, predictions.map(x => JSON.stringify(x)).join("\n") + "\n");
    }
    const j = await judge(judgeLlm, s, p);
    judgments.push(j); judged.add(key(p.arm, s.id));
    await Bun.write(judgePath, judgments.map(x => JSON.stringify(x)).join("\n") + "\n");
    opts.log?.(`${p.arm} ${s.id} [${s.category}] ${j.label || "?"} (${p.outcome})`);
  };
  for (const arm of opts.arms) {
    const todo = samples.filter(s => !judged.has(key(arm, s.id)));
    const work = async (s: Sample) => guard(async () => {
      const p = predicted.get(key(arm, s.id)) ?? (arm === "direct" ? await predictDirect(llm, s)
        : await predictHarness(llm, s, arm as Config["organization"], join(opts.out, arm, s.id.replaceAll(":", "-")), opts.calls));
      if (!p) throw new ProviderError("harness run stopped on provider errors");
      await record(s, p);
    });
    // ponytail: direct predictions run in a small pool; harness samples run one at a time since each run has its own concurrency
    const width = arm === "direct" ? Math.max(1, opts.concurrency) : 1;
    for (let i = 0; i < todo.length; i += width) await Promise.all(todo.slice(i, i + width).map(work));
  }
  const report = {
    source: { ...SOURCE, sha256 }, model: llm.model.id, judgeModel: judgeLlm.model.id, arms: opts.arms, categories: opts.categories ?? CATEGORIES,
    perCategory: opts.perCategory, seed: opts.seed, harnessCallsPerSample: opts.calls, sampleIds: samples.map(s => s.id),
    notes: [
      "Scores: correct=1, partial=0.5, wrong=0 per the reference judge. The paper does not state the judge model for its main results (its human-agreement study used gemini-2.5-flash; the repository example uses gpt-4o-mini), so scores from another judge model are not directly comparable.",
      "Temperatures 0.3 (prediction) and 0 (judge) are requested as in the reference; pi-ai omits temperature when signed in with ChatGPT.",
      "Harness arms read the same conversation split into files under the tool read limit; they answer through answer.txt.",
    ],
    results: summarize(judgments.filter(j => samples.some(s => s.id === j.id)), predictions.filter(p => samples.some(s => s.id === p.id))),
  };
  await Bun.write(join(opts.out, "report.json"), JSON.stringify(report, null, 2));
  return report;
}
