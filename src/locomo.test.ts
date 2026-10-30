import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { buildSamples, judgePrompt, labelToScore, parseJudge, predictHarness, runLocomo, selectSamples, SOURCE, type LocomoItem, type PlusItem } from "./locomo.ts";

const conversation = {
  speaker_a: "Ann", speaker_b: "Bob",
  session_1_date_time: "1:00 pm on 1 May, 2023", session_1: [{ speaker: "Ann", text: "I adopted a cat." }, { speaker: "Bob", text: " Nice! ", blip_caption: "a photo of a cat" }],
  session_2_date_time: "9:30 am on 20 May, 2023", session_2: [{ speaker: "Bob", text: "I moved to Oslo." }],
  session_3_date_time: "4:15 PM on 10 June, 2023", session_3: [{ speaker: "Ann", text: "My cat is sick." }],
};
const locomo: LocomoItem[] = [{
  sample_id: "c1", conversation,
  qa: [
    { question: "Where did Bob move?", answer: "Oslo", evidence: ["D2:1"], category: 4 },
    { question: "What did Ann adopt?", answer: 2023, evidence: "D1:1; D9:9", category: 1 },
    { question: "Is Bob a doctor?", evidence: ["D1"], category: 5 },
  ],
}];
// Query lands 7 days after session 3 (17 June); "three weeks" back puts the cue on 27 May, between sessions 2 and 3.
const plus: PlusItem[] = [
  { cue_dialogue: "A: I'm allergic to peanuts.\nB: Good to know.", trigger_query: "A: Any snack ideas for the trip?", time_gap: "three weeks later" },
  { cue_dialogue: "A: x", trigger_query: "A: y", time_gap: "one week later" }, // cue equals session 3's time
];

test("samples follow the reference construction: context, evidence, stitching, and failures", () => {
  const samples = buildSamples(locomo, plus);
  expect(samples.map(s => s.category)).toEqual(["single-hop", "multi-hop", "adversarial", "Cognitive", "Cognitive"]);
  const [single, multi, adversarial, cognitive, collided] = samples;
  expect(single!.input_prompt).toBe([
    "DATE: 1:00 pm on 1 May, 2023", "CONVERSATION:", 'Ann said, "I adopted a cat."', 'Bob said, "Nice!" and shared a photo of a cat.', "",
    "DATE: 9:30 am on 20 May, 2023", "CONVERSATION:", 'Bob said, "I moved to Oslo."', "",
    "DATE: 4:15 PM on 10 June, 2023", "CONVERSATION:", 'Ann said, "My cat is sick."', "", "Question: Where did Bob move?",
  ].join("\n"));
  expect(single!.evidence).toBe("Bob：I moved to Oslo.");
  expect(multi!.evidence).toBe("Ann：I adopted a cat.\n[D9:9] [Missing turn]");
  expect(multi!.answer).toBe(2023);
  expect(adversarial!.evidence).toBe("[D1] [Parse error]");
  expect("answer" in adversarial!).toBe(false);
  expect(cognitive!.input_prompt.split("\n")).toEqual([
    'Ann said, "I adopted a cat."', 'Bob said, "Nice!"', 'Bob said, "I moved to Oslo."',
    `Ann said, "I'm allergic to peanuts."`, 'Bob said, "Good to know."', 'Ann said, "My cat is sick."', 'Ann said, "Any snack ideas for the trip?"',
  ]);
  expect(cognitive!.evidence).toBe("Ann：I'm allergic to peanuts.\nBob：Good to know.");
  expect(cognitive!.trigger).toBe("A: Any snack ideas for the trip?");
  expect(collided!.input_prompt).toBe(""); // the reference raises on equal timestamps and records an empty prompt
  expect(samples.every(s => s.chunks.every(c => c.length <= 3000))).toBe(true);
});

test("selection is stratified and reproducible from the seed", () => {
  const samples = buildSamples(locomo, plus);
  const a = selectSamples(samples, 1, 7).map(s => s.id), b = selectSamples(samples, 1, 7).map(s => s.id);
  expect(a).toEqual(b);
  expect(a).toHaveLength(4); // single-hop, multi-hop, adversarial, Cognitive; no temporal or common-sense in the fixture
});

test("judge prompts, parsing, and scores match the reference", () => {
  expect(judgePrompt("single-hop", "E", "P", 0)).toContain("Reference Answer:\n\n\nModel Prediction:\nP");
  expect(judgePrompt("multi-hop", "E", "P", 2023)).toContain("Reference Answer:\n2023\n");
  expect(judgePrompt("unknown", "E", "P", "G")).toContain("You are an expert evaluator.");
  expect(parseJudge('{"label": "partial", "reason": "close"}')).toEqual({ label: "partial", reason: "close", fallback: false });
  expect(parseJudge('{"reason": "r", "label": "wrong"}')).toEqual({ label: "wrong", reason: "r", fallback: false });
  expect(parseJudge("The answer is incorrect.")).toMatchObject({ label: "correct", fallback: true }); // the reference's substring fallback
  expect([labelToScore("correct"), labelToScore(" Partial "), labelToScore("wrong"), labelToScore("")]).toEqual([1, 0.5, 0, 0]);
});

function llmWith(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { models, model: faux.getModel() };
}

async function cachedData() {
  const dir = mkdtempSync(join(tmpdir(), "locomo-"));
  for (const [name, data] of [["locomo10.json", locomo], ["locomo_plus.json", plus]] as const) await Bun.write(join(dir, "data", `${SOURCE.commit.slice(0, 12)}-${name}`), JSON.stringify(data));
  return dir;
}

test("provider errors are never scored, and a rerun completes without duplicates", async () => {
  const dir = await cachedData();
  const opts = { out: join(dir, "out"), cacheDir: join(dir, "data"), arms: ["direct"], perCategory: "all" as const, seed: 1, calls: 5, concurrency: 1 };
  const parallel = { ...opts, concurrency: 3 };
  const error = fauxAssistantMessage("", { stopReason: "error", errorMessage: "usage limit" });
  const judgeOk = fauxAssistantMessage('{"label": "correct", "reason": "ok"}');
  // First sample answers and is judged; then the provider fails three times in a row.
  await expect(runLocomo(llmWith([fauxAssistantMessage("Oslo"), judgeOk, error, error, error]), llmWith([]), opts).catch(e => { throw e; }))
    .rejects.toThrow("consecutive provider errors");
  // One provider answers both roles: judge prompts get a verdict, everything else an answer.
  const second = llmWith(Array(20).fill((ctx: { messages: Message[] }) =>
    JSON.stringify(ctx.messages).includes("Judge") ? judgeOk : fauxAssistantMessage("answer")));
  const report = await runLocomo(second, second, parallel);
  const preds = (await Bun.file(join(opts.out, "predictions.jsonl")).text()).trim().split("\n").map(l => JSON.parse(l));
  expect(preds.map(p => p.id)).toEqual([...new Set(preds.map(p => p.id))]);
  expect(preds.some(p => /usage limit/.test(p.prediction))).toBe(false);
  expect(preds.find(p => p.id === "plus:1").prediction).toBe("(no input_prompt)");
  expect(report.results.direct!.judged).toBe(5);
  expect(report.results.direct!.overallAvg).toBe(1);
  expect(report.results.direct!.outcomes).toEqual({ answered: 4, "no-input": 1 });
});

test("harness arm reads the split conversation and answers through answer.txt", async () => {
  const sample = buildSamples(locomo, plus)[0]!;
  const brain = (ctx: { messages: Message[] }) => {
    const used = ctx.messages.filter(m => m.role === "toolResult").map(m => m.toolName);
    const first = ctx.messages.find(m => m.role === "user")!.content;
    const opening = typeof first === "string" ? first : first.map(b => (b as { text?: string }).text ?? "").join("");
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
    if (opening.includes("(verify")) return call("task_finish", { result: "answer.txt checked", verdict: "pass" });
    if (!used.includes("file_read")) return call("file_read", { path: "conversation/index.txt" });
    if (used.filter(u => u === "file_read").length < 2) return call("file_read", { path: "conversation/part-001.txt" });
    if (!used.includes("file_write")) return call("file_write", { path: "answer.txt", content: "Oslo" });
    if (!used.includes("goal_complete")) return call("goal_complete", { id: "G0", deliverable: "answer.txt" });
    return call("task_finish", { result: "submitted" });
  };
  const dir = mkdtempSync(join(tmpdir(), "locomo-harness-"));
  const llm = llmWith(Array(30).fill(brain));
  const p = await predictHarness(llm, sample, "single", dir, 20);
  expect(p).toMatchObject({ arm: "single", prediction: "Oslo", outcome: "done" });
  expect(await Bun.file(join(dir, "workspace", "conversation", "index.txt")).text()).toStartWith("part-001.txt: DATE: 1:00 pm on 1 May, 2023");
});
