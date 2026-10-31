import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { defaultConfig, Store } from "../src/db.ts";
import { runScheduler } from "../src/scheduler.ts";
import { call, marketBrain } from "../src/fixtures/market-brain.ts";
import { collect, diagnosticsMarkdown, traceMarkdown } from "./rsi-traces.ts";

test("traces recover every call, including steps a context_edit replaced, and summarize tool use and CLM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rsi-traces-"));
  mkdirSync(join(dir, "workspace"));
  const store = new Store(join(dir, "state.sqlite"));
  store.init("Answer in answer.txt", "", { ...defaultConfig, maxConcurrency: 1 });
  const brain = marketBrain(["answer in answer.txt"], (_, used, messages) => {
    const edited = messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[context note"));
    if (!edited && used.filter(u => u === "knowledge_search").length < 2) return call("knowledge_search", { query: "Oslo" });
    if (!edited) return call("context_edit", { from: 1, to: 4, note: "no knowledge" });
    if (!used.includes("file_write")) return call("file_write", { path: "answer.txt", content: "Oslo" });
    if (!used.includes("memory_write")) return call("memory_write", { content: "answered in answer.txt" });
    return call("task_finish", { result: "answer.txt" });
  });
  const faux = fauxProvider(), models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(Array(60).fill(brain));
  expect((await runScheduler({ store, models, model: faux.getModel(), workspace: join(dir, "workspace"), contextDir: join(dir, "contexts") })).status).toBe("done");
  store.db.close();

  const s = collect(join(dir, "state.sqlite"), "locomo-c1-0", 1);
  const work = s.episodes.find(e => e.kind === "work")!;
  expect(work.calls.map(c => c.name)).toEqual(["knowledge_search", "knowledge_search", "context_edit", "file_write", "memory_write", "task_finish"]);
  expect(s.memoryWrites.worker).toBe(1);
  const trace = traceMarkdown(s);
  expect(trace).toContain('1. [');
  expect(trace).toMatch(/## Tasks\n- T-\S+ steer done by lead: \d+ calls — /);
  expect(trace).toContain('knowledge_search {"query":"Oslo"} → ');
  const d = diagnosticsMarkdown([s]);
  expect(d).toContain("| knowledge_search | 2 | 0 |");
  expect(d).toContain("### Lookups that found nothing (2)");
  expect(d).toContain('2× knowledge_search {"query":"Oslo"}');
  // lead, three investors, a worker, three critics and a verifier; twelve episodes in twenty calls.
  expect(d).toMatch(/\| locomo-c1-0 \| 1 \| 9 \| 12 \| 20 \| [\d,]+ \| 1 \| 1 \|/);
  expect(d).toContain("Never called (some tools are withheld from some roles): memory_edit");
});
