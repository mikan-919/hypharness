import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { openModel } from "./auth.ts";
import { defaultConfig, Store, type Config } from "./db.ts";
import { report, runScheduler } from "./scheduler.ts";
import type { Runtime } from "./agent.ts";
import { CATEGORIES, HARNESS_ARMS, runLocomo } from "./locomo.ts";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string", default: ".hyph" },
    port: { type: "string", default: "4321" },
    constraints: { type: "string", default: "" },
    calls: { type: "string" },
    agents: { type: "string" },
    concurrency: { type: "string" },
    rounds: { type: "string" },
    "allow-shell": { type: "boolean", default: false },
    check: { type: "string" },
    arms: { type: "string", default: "direct,market" },
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

// Host-side permissions and budgets come from this run's flags; the purpose stays as stored.
function applyFlags(store: Store, base: Config) {
  store.setMeta("config", JSON.stringify({
    ...base, allowShell: opts["allow-shell"],
    maxModelCalls: int(opts.calls, "calls") ?? base.maxModelCalls,
    maxAgents: int(opts.agents, "agents") ?? base.maxAgents,
    maxConcurrency: int(opts.concurrency, "concurrency") ?? base.maxConcurrency,
  }));
}

async function checkWorkspace(workspace: string) {
  if (!opts.check) return null;
  const proc = Bun.spawn(["sh", "-c", opts.check], { cwd: workspace, stdout: "inherit", stderr: "inherit" });
  return await proc.exited;
}

const [command, ...rest] = positionals;
const log = (line: string) => console.log(line);

if (command === "serve") {
  await import("./dashboard/server.ts");
} else if (command === "locomo") {
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
  const { store } = open(join(opts.dir!, "main"));
  if (!store.purpose) throw new Error(`No session in ${opts.dir}`);
  console.log(`purpose: ${store.purpose}`);
  for (const g of store.all<Record<string, string>>("select * from goals order by created_at")) console.log(`${g.id} [${g.status}] owner=${g.owner}: ${g.description}`);
  for (const a of store.agents()) console.log(`agent ${a.id} [${a.status}]: ${a.role}`);
  console.log(JSON.stringify(report(store, "rounds", 0, 0), null, 2));
} else if (command === "mcp-login") {
  if (!rest[0]) throw new Error("mcp-login requires a server name from mcp.json");
  const { mcpLogin } = await import("./mcp.ts");
  await mcpLogin(join(opts.dir!, "main"), rest[0]);
} else if (command === "chat") {
  const base = `http://127.0.0.1:${int(opts.port, "port")}`;
  console.log("Front chat. An empty line ends it.");
  process.stdout.write("> ");
  for await (const line of console) {
    if (!line.trim()) break;
    const response = await fetch(`${base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ text: line }) });
    if (!response.ok) throw new Error(`Chat failed: ${await response.text()}`);
    const r = await response.json() as { reply: string };
    console.log(r.reply);
    process.stdout.write("> ");
  }
} else if (command === "run") {
  const purpose = rest.join(" ").trim();
  const env = open(opts.dir!);
  if (purpose) env.store.init(purpose, opts.constraints!, defaultConfig);
  else if (!env.store.purpose) throw new Error("Give a purpose to start, e.g. bun run start 'Write a CLI that ...'");
  applyFlags(env.store, env.store.config);
  const rt: Runtime = { ...env, ...(await openModel()), log };
  const r = await runScheduler(rt, int(opts.rounds, "rounds"));
  console.log(JSON.stringify({ ...r, checkExit: await checkWorkspace(env.workspace) }, null, 2));
  env.store.db.close();
} else {
  const purpose = [command, ...rest].filter(Boolean).join(" ").trim();
  if (!purpose) throw new Error("Start the resident process with 'serve', or supply an order");
  const base = `http://127.0.0.1:${int(opts.port, "port")}`;
  const response = await fetch(`${base}/api/order`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ purpose }) });
  if (!response.ok) throw new Error(`Could not set order: ${await response.text()}`);
  console.log(`Order updated: ${purpose}`);
}
