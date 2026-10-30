// Scores a candidate hypharness tree on a fixed LoCoMo-Plus subset and, given a baseline, decides whether it is accepted.
// The candidate is copied, its src/locomo.ts (sample selection and judge) is replaced with this tree's copy, and its
// own type check and tests must pass. Accuracy comes from the judge; context length from every model call's input tokens.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $ } from "bun";

export type Eval = {
  ok: boolean; accepted?: boolean; transient?: boolean; reason?: string; commit?: string; sampleIds?: string[]; score?: number;
  perSample?: Record<string, number>; context?: { calls: number; maxTokens: number; meanTokens: number; meanPeakTokens: number };
};

// After RRSI (arXiv:2609.24972): the score may not fall below the noise band; a gain beyond the band may pay for
// proportionally more context; inside the band the candidate must shrink the context.
// ponytail: delta is a fixed flag; calibrate it from repeated baseline runs when acceptances look like noise
export function accept(score: number, peak: number, baseScore: number, basePeak: number, delta: number) {
  if (score < baseScore - delta) return false;
  if (score > baseScore + delta) return peak <= basePeak * (1 + (score - baseScore));
  return peak < basePeak * 0.95;
}

async function main() {
  const { values: opts, positionals: [candidateArg] } = parseArgs({
    allowPositionals: true,
    options: {
      baseline: { type: "string" },
      out: { type: "string" },
      "per-category": { type: "string", default: "3" },
      seed: { type: "string", default: "1" },
      calls: { type: "string", default: "40" },
      "harness-concurrency": { type: "string", default: "4" },
      delta: { type: "string", default: "0.05" },
    },
  });
  if (!candidateArg) throw new Error("usage: bun scripts/rsi-eval.ts <candidate-dir> [--baseline eval.json] [--out DIR]");

  const pinned = resolve(import.meta.dir, "..");
  const candidate = resolve(candidateArg);
  const out = resolve(opts.out ?? join(pinned, ".hyph", "rsi", `eval-${Date.now()}`));
  const copy = join(out, "tree");
  mkdirSync(out, { recursive: true });

  const finish = async (e: Eval) => {
    e.accepted ??= false;
    await Bun.write(join(out, "eval.json"), JSON.stringify(e, null, 2));
    console.log(JSON.stringify({ ...e, perSample: undefined, sampleIds: undefined }, null, 2));
    process.exit(e.accepted ? 0 : 1);
  };

  await $`rsync -a --delete --exclude node_modules --exclude .hyph --exclude rsi-traces --exclude auth.json --exclude .env ${candidate}/ ${copy}/`.quiet();
  const commit = (await $`git -C ${candidate} rev-parse HEAD`.nothrow().quiet().text()).trim() || undefined;

  // Deleting a test must not be a way to pass.
  const tests = (dir: string) => new Set(readdirSync(join(dir, "src"), { recursive: true }).map(String).filter(f => f.endsWith(".test.ts")));
  const removed = [...tests(pinned)].filter(t => !tests(copy).has(t));
  if (removed.length) await finish({ ok: false, commit, reason: `tests removed: ${removed.join(", ")}` });

  await $`cp ${join(pinned, "src", "locomo.ts")} ${join(copy, "src", "locomo.ts")}`;
  await $`bun install`.cwd(copy).quiet();
  for (const cmd of [["bun", "run", "check"], ["bun", "test"]]) {
    const r = Bun.spawnSync(cmd, { cwd: copy, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) await finish({ ok: false, commit, reason: `${cmd.join(" ")} exited ${r.exitCode}` });
  }

  // auth.json is read from cwd; the link stays outside the candidate's workspace.
  if (!existsSync(join(copy, "auth.json"))) symlinkSync(join(pinned, "auth.json"), join(copy, "auth.json"));
  const locomoOut = join(out, "locomo");
  const run = Bun.spawnSync(["bun", "src/index.ts", "locomo", "--arms", "dynamic", "--per-category", opts["per-category"]!, "--seed", opts.seed!,
    "--calls", opts.calls!, "--harness-concurrency", opts["harness-concurrency"]!, "--dir", join(pinned, ".hyph"), "--out", locomoOut],
  { cwd: copy, stdout: "inherit", stderr: "inherit" });
  // Provider failures stop the benchmark; the run resumes from the same --out, so this is not a verdict on the candidate.
  if (run.exitCode !== 0) await finish({ ok: false, transient: true, commit, reason: `locomo exited ${run.exitCode}` });

  const report = await Bun.file(join(locomoOut, "report.json")).json();
  const perSample: Record<string, number> = {};
  for (const line of (await Bun.file(join(locomoOut, "judgments.jsonl")).text()).split("\n").filter(Boolean)) {
    const j = JSON.parse(line);
    if (j.arm === "dynamic") perSample[j.id] = j.score;
  }

  // Prompt size per call as the provider reported it (fresh + cached input); stored message chars overcount reasoning data.
  const all: number[] = [], peaks: number[] = [];
  const armDir = join(locomoOut, "dynamic");
  for (const sample of existsSync(armDir) ? readdirSync(armDir) : []) {
    const path = join(armDir, sample, "state.sqlite");
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    const sizes = db.query("select input + cache_read + cache_write n from usage").all().map(r => (r as { n: number }).n);
    db.close();
    if (!sizes.length) continue;
    all.push(...sizes);
    peaks.push(Math.max(...sizes));
  }
  const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  const result: Eval = {
    ok: true, commit, sampleIds: report.sampleIds, score: report.results.dynamic.overallAvg, perSample,
    context: { calls: all.length, maxTokens: all.length ? Math.max(...all) : 0, meanTokens: mean(all), meanPeakTokens: mean(peaks) },
  };

  if (!opts.baseline) await finish({ ...result, accepted: true, reason: "baseline" });
  const base: Eval = await Bun.file(opts.baseline!).json();
  if (JSON.stringify(base.sampleIds) !== JSON.stringify(result.sampleIds)) throw new Error("baseline was scored on different samples; use the same --per-category and --seed");
  const accepted = accept(result.score!, result.context!.meanPeakTokens, base.score!, base.context!.meanPeakTokens, Number(opts.delta));
  await finish({ ...result, accepted, reason: `score ${base.score} -> ${result.score}, mean peak tokens ${base.context!.meanPeakTokens} -> ${result.context!.meanPeakTokens}` });
}

if (import.meta.main) await main();
