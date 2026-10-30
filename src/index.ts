import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openModel } from "./auth.ts";
import { defaultConfig, Store, type Config } from "./db.ts";
import { report, runScheduler } from "./scheduler.ts";
import type { Runtime } from "./agent.ts";
import { CATEGORIES, HARNESS_ARMS, runLocomo } from "./locomo.ts";
import { openChat, reply } from "./chat.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: ".hyph" },
    constraints: { type: "string", default: "" },
    mode: { type: "string", default: "dynamic" },
    calls: { type: "string" },
    agents: { type: "string" },
    concurrency: { type: "string" },
    rounds: { type: "string" },
    "allow-shell": { type: "boolean", default: false },
    check: { type: "string" },
    arms: { type: "string", default: "direct,dynamic" },
    "per-category": { type: "string", default: "2" },
    "harness-concurrency": { type: "string", default: "1" },
    categories: { type: "string" },
    seed: { type: "string", default: "1" },
    "judge-model": { type: "string" },
    out: { type: "string" },
  },
});

const int = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
};

function open(dir: string) {
  mkdirSync(join(dir, "workspace"), { recursive: true });
  return { store: new Store(join(dir, "state.sqlite")), workspace: resolve(dir, "workspace"), contextDir: resolve(dir, "contexts") };
}

function configFor(mode: string): Config {
  if (mode === "single") return { ...defaultConfig, organization: "single", maxAgents: 1, maxConcurrency: 1 };
  if (mode === "fixed") return { ...defaultConfig, organization: "fixed", maxAgents: 3 };
  if (mode === "dynamic") return { ...defaultConfig };
  throw new Error("--mode must be single, fixed, or dynamic");
}

// Host-side permissions and budgets come from this run's flags; the purpose and organization mode stay as stored.
function applyFlags(store: Store, base: Config) {
  store.setMeta("config", JSON.stringify({
    ...base, allowShell: opts["allow-shell"],
    maxModelCalls: int(opts.calls, "calls") ?? base.maxModelCalls,
    maxAgents: base.organization === "single" ? 1 : int(opts.agents, "agents") ?? base.maxAgents,
    maxConcurrency: base.organization === "single" ? 1 : int(opts.concurrency, "concurrency") ?? base.maxConcurrency,
  }));
}

async function checkWorkspace(workspace: string) {
  if (!opts.check) return null;
  const proc = Bun.spawn(["sh", "-c", opts.check], { cwd: workspace, stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

const [command, ...rest] = positionals;
const log = (line: string) => console.log(line);

if (command === "locomo") {
  const arms = opts.arms!.split(",").map(a => a.trim()).filter(Boolean);
  for (const a of arms) if (!["direct", ...HARNESS_ARMS].includes(a)) throw new Error(`Unknown arm ${a}; use direct, ${HARNESS_ARMS.join(", ")}`);
  const categories = opts.categories?.split(",").map(c => c.trim()).filter(Boolean);
  for (const c of categories ?? []) if (!CATEGORIES.includes(c)) throw new Error(`Unknown category ${c}; use ${CATEGORIES.join(", ")}`);
  const perCategory = opts["per-category"] === "all" ? "all" : int(opts["per-category"], "per-category")!;
  const llm = await openModel();
  const judgeLlm = opts["judge-model"] ? await openModel(opts["judge-model"]) : llm;
  const out = opts.out ?? join(opts.dir!, `locomo-${Date.now()}`);
  log(`results: ${out}`);
  const report = await runLocomo(llm, judgeLlm, {
    out, cacheDir: join(opts.dir!, "locomo-data"), arms, categories, perCategory, seed: Number.isSafeInteger(Number(opts.seed)) ? Number(opts.seed) : (() => { throw new Error("--seed must be an integer"); })(), log,
    calls: int(opts.calls, "calls") ?? 40, concurrency: int(opts.concurrency, "concurrency") ?? 2, harnessConcurrency: int(opts["harness-concurrency"], "harness-concurrency"),
  });
  console.table(Object.fromEntries(Object.entries(report.results).map(([arm, r]) => [arm, {
    avg: r.overallAvg, judged: r.judged, ...Object.fromEntries(Object.entries(r.byCategory).map(([c, v]) => [c, v.avg])),
    calls: r.usage.calls, tokens: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output, seconds: Math.round(r.ms / 1000),
  }])));
  console.log(`report: ${join(out, "report.json")}`);
} else if (command === "status") {
  const { store } = open(opts.dir!);
  if (!store.purpose) throw new Error(`No session in ${opts.dir}`);
  console.log(`purpose: ${store.purpose}`);
  for (const g of store.all<Record<string, string>>("select * from goals order by created_at")) console.log(`${g.id} [${g.status}] owner=${g.owner}: ${g.description}`);
  for (const a of store.agents()) console.log(`agent ${a.id} [${a.status}]: ${a.role}`);
  console.log(JSON.stringify(report(store, "rounds", 0, 0), null, 2));
} else if (command === "chat") {
  // The same chat the dashboard shows: its log and memory live in <dir>/chat.
  mkdirSync(join(opts.dir!, "chat"), { recursive: true });
  const store = openChat(join(opts.dir!, "chat", "state.sqlite"));
  const llm = await openModel();
  console.log("Front chat. An empty line ends it.");
  process.stdout.write("> ");
  for await (const line of console) {
    if (!line.trim()) break;
    const r = await reply(llm, store, line.trim());
    console.log(`${r.reply}\n  [${r.calls} calls, ${r.lookups} lookups, peak ${r.peakTokens} tokens, ${r.remembered} messages moved to memory]`);
    process.stdout.write("> ");
  }
  store.db.close();
} else if (command === "bench") {
  const purpose = rest.join(" ").trim();
  if (!purpose) throw new Error("bench requires a purpose");
  const llm = await openModel();
  const root = join(opts.dir!, `bench-${Date.now()}`);
  const results: Record<string, unknown> = {};
  for (const mode of ["single", "fixed", "dynamic"]) {
    const env = open(join(root, mode));
    env.store.init(purpose, opts.constraints!, configFor(mode));
    applyFlags(env.store, env.store.config);
    log(`== ${mode}`);
    const r = await runScheduler({ ...env, ...llm, log }, int(opts.rounds, "rounds"));
    results[mode] = { ...r, verified: env.store.goal("G0")!.verified_by !== null, checkExit: await checkWorkspace(env.workspace) };
    env.store.db.close();
  }
  await Bun.write(join(root, "report.json"), JSON.stringify(results, null, 2));
  console.table(results);
  console.log(`report: ${join(root, "report.json")}`);
} else {
  const purpose = [command, ...rest].filter(Boolean).join(" ").trim();
  const env = open(opts.dir!);
  if (purpose) env.store.init(purpose, opts.constraints!, configFor(opts.mode!));
  else if (!env.store.purpose) throw new Error("Give a purpose to start, e.g. bun run start 'Write a CLI that ...'");
  applyFlags(env.store, env.store.config);
  const rt: Runtime = { ...env, ...(await openModel()), log };
  const r = await runScheduler(rt, int(opts.rounds, "rounds"));
  console.log(JSON.stringify({ ...r, checkExit: await checkWorkspace(env.workspace) }, null, 2));
  env.store.db.close();
}
