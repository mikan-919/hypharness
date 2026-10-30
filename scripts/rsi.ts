// Recursive self-improvement loop. Each generation, the incumbent harness runs a dynamic session whose workspace is a git
// worktree of its own source; scripts/rsi-eval.ts scores the resulting candidate against the incumbent; an accepted
// candidate becomes the harness that runs the next generation. state.json records every generation for the dashboard.
// Every step resumes after a stop: the session from its state.sqlite, the evaluation from its LoCoMo output.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { $, type Subprocess } from "bun";
import type { Eval } from "./rsi-eval.ts";
import { resolveSettings, type RsiSettings } from "./rsi-defaults.ts";

const { values: opts } = parseArgs({
  options: {
    dir: { type: "string", default: ".hyph/rsi" },
    // Settings left out keep the value of the previous start (state.json), then the defaults in rsi-defaults.ts.
    purpose: { type: "string" },
    constraints: { type: "string" },
    // Organization of the improver session.
    mode: { type: "string" },
    // Model-call budget of one improver session, and of one question in an evaluation.
    calls: { type: "string" },
    "eval-calls": { type: "string" },
    "per-category": { type: "string" },
    seed: { type: "string" },
    delta: { type: "string" },
    // Not carried over: questions solved at once in an evaluation (defaults to all of them) and the generation limit.
    parallel: { type: "string" },
    generations: { type: "string" },
  },
});

export type Generation = {
  gen: number; base: number | null; phase: "improve" | "evaluate" | "done"; startedAt: number; endedAt?: number;
  commit?: string; status?: string; note?: string; eval?: Omit<Eval, "perSample" | "sampleIds">; accepted?: boolean; reason?: string; error?: string;
};
export type State = {
  incumbent?: { gen: number; commit: string; tree: string; eval: string };
  settings: RsiSettings; generations: Generation[];
};

const RETRY_MS = 10 * 60_000;

const repo = resolve(import.meta.dir, "..");
const root = resolve(opts.dir!);
const statePath = join(root, "state.json"), pidPath = join(root, "pid");
const genDir = (gen: number) => join(root, `gen-${gen}`);
// Only the loop that wrote the pid file removes it; a second start that is refused must leave the running loop visible.
const releasePid = () => { if (existsSync(pidPath) && readFileSync(pidPath, "utf8") === String(process.pid)) rmSync(pidPath); };

const log = (line: string) => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.log(stamped);
  appendFileSync(join(root, "rsi.log"), `${stamped}\n`);
};

let child: Subprocess | undefined;
async function run(cmd: string[], logPath: string) {
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `\n=== ${new Date().toISOString()} ${cmd.slice(0, 3).join(" ")} …\n`);
  const fd = openSync(logPath, "a");
  try {
    child = Bun.spawn(cmd, { cwd: repo, stdout: fd, stderr: fd, env: process.env });
    return await child.exited;
  } finally {
    child = undefined;
    closeSync(fd);
  }
}

function history(state: State) {
  return state.generations.filter(g => g.phase === "done" && g.gen > 0).map(g => [
    `## Generation ${g.gen} (built on ${g.base}) — ${g.accepted ? "accepted" : "rejected"}`,
    `Result: ${g.reason ?? "-"}`, "Note from the improver:", g.note?.trim() || "(none)",
  ].join("\n")).join("\n\n") || "No earlier generations.";
}

// Meta-Harness (arXiv:2603.28052): the improver reads raw traces, not summaries, of the harness it is changing.
async function writeTraces(state: State, workspace: string) {
  const dst = join(workspace, "rsi-traces"), src = dirname(state.incumbent!.eval);
  rmSync(dst, { recursive: true, force: true });
  mkdirSync(dst, { recursive: true });
  await $`cp ${state.incumbent!.eval} ${join(dst, "eval.json")}`;
  await $`rsync -a --prune-empty-dirs '--include=*/' '--include=contexts/***' --include=answer.txt '--include=*.jsonl' '--exclude=*' ${join(src, "locomo")}/ ${join(dst, "locomo")}/`.quiet();
  await Bun.write(join(dst, "history.md"), `# Earlier generations\n\n${history(state)}\n`);
}

async function improve(state: State, g: Generation) {
  const dir = genDir(g.gen), workspace = join(dir, "workspace");
  if (!existsSync(workspace)) await $`git -C ${repo} worktree add -f -B rsi/gen-${g.gen} ${workspace} ${state.incumbent!.commit}`.quiet();
  // The improver's shell runs bun check and bun test in the worktree, which has no node_modules of its own.
  if (!existsSync(join(workspace, "node_modules"))) await $`bun install`.cwd(workspace).quiet();
  const fresh = !existsSync(join(dir, "state.sqlite"));
  // A resumed session keeps the traces it started with, including the note the improver already wrote.
  if (fresh) await writeTraces(state, workspace);
  // Purpose, constraints and organization belong to a new session; a resumed one keeps those it started with.
  const { purpose, constraints, mode, calls } = state.settings;
  const code = await run(["bun", join(state.incumbent!.tree, "src", "index.ts"), ...(fresh ? [purpose, `--constraints=${constraints}`, "--mode", mode] : []),
    "--dir", dir, "--allow-shell", "--calls", calls], join(dir, "run.log"));
  const status = [...readFileSync(join(dir, "run.log"), "utf8").matchAll(/"status": "(\w+)"/g)].at(-1)?.[1];
  if (code !== 0 || !status || status === "error") throw new Error(`improver session ended with exit ${code}, status ${status ?? "unknown"}`);
  g.status = status;
  const note = join(workspace, "rsi-traces", "note.md");
  g.note = existsSync(note) ? readFileSync(note, "utf8").slice(0, 4000) : undefined;
  // rsi-traces/ is in .gitignore; naming it in a pathspec makes git add fail on the ignored path.
  await $`git -C ${workspace} add -A`.quiet();
  if (!(await $`git -C ${workspace} diff --cached --name-only`.text()).trim()) {
    Object.assign(g, { phase: "done", accepted: false, reason: "no changes", endedAt: Date.now() });
    return;
  }
  const subject = g.note?.split("\n").find(l => l.trim())?.replace(/^#+\s*/, "").slice(0, 72) || "candidate";
  await $`git -C ${workspace} commit -q -m ${`rsi gen ${g.gen}: ${subject}`} -m ${g.note ?? ""}`;
  g.commit = (await $`git -C ${workspace} rev-parse HEAD`.text()).trim();
  g.phase = "evaluate";
}

async function evaluate(state: State, g: Generation) {
  const dir = genDir(g.gen), workspace = join(dir, "workspace"), out = join(dir, "eval");
  if (!existsSync(workspace)) await $`git -C ${repo} worktree add -f --detach ${workspace} HEAD`.quiet();
  g.commit ??= (await $`git -C ${workspace} rev-parse HEAD`.text()).trim();
  rmSync(join(out, "eval.json"), { force: true });
  const { perCategory, seed, delta, evalCalls, parallel } = state.settings;
  await run(["bun", join(repo, "scripts", "rsi-eval.ts"), workspace, "--out", out, "--per-category", perCategory, "--seed", seed, "--calls", evalCalls,
    "--delta", delta, "--harness-concurrency", parallel ?? String(6 * Number(perCategory)), ...(state.incumbent ? ["--baseline", state.incumbent.eval] : [])], join(dir, "eval.log"));
  const evalPath = join(out, "eval.json");
  const e: Eval | undefined = existsSync(evalPath) ? JSON.parse(readFileSync(evalPath, "utf8")) : undefined;
  if (!e || e.transient) throw new Error(`evaluation did not finish: ${e?.reason ?? "no eval.json (see eval.log)"}`);
  if (!state.incumbent && !e.accepted) throw new Error(`the starting harness fails its own checks: ${e.reason}`);
  const { perSample: _, sampleIds: __, ...summary } = e;
  Object.assign(g, { eval: summary, accepted: e.accepted, reason: e.reason, phase: "done", endedAt: Date.now() });
  if (e.accepted) state.incumbent = { gen: g.gen, commit: g.commit!, tree: join(out, "tree"), eval: evalPath };
}

async function main() {
  mkdirSync(root, { recursive: true });
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf8"));
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    if (alive && pid !== process.pid) throw new Error(`An RSI loop is already running in ${root} (pid ${pid})`);
  }
  writeFileSync(pidPath, String(process.pid));
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { child?.kill("SIGTERM"); releasePid(); process.exit(0); });

  const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { settings: {}, generations: [] };
  state.settings = resolveSettings(state.settings, state.generations.length > 0, opts);
  const save = () => writeFileSync(statePath, JSON.stringify(state, null, 2));
  const limit = state.settings.generations ? Number(state.settings.generations) : Infinity;
  log(`loop started (pid ${process.pid}); incumbent ${state.incumbent ? `gen ${state.incumbent.gen}` : "none yet"}`);

  for (;;) {
    let g = state.generations.at(-1);
    if (!g || g.phase === "done") {
      if (state.generations.length - 1 >= limit) break;
      g = { gen: state.generations.length, base: state.incumbent?.gen ?? null, phase: g ? "improve" : "evaluate", startedAt: Date.now() };
      state.generations.push(g);
      save();
    }
    log(`gen ${g.gen}: ${g.phase}`);
    try {
      await (g.phase === "improve" ? improve(state, g) : evaluate(state, g));
      g.error = undefined;
      if (g.phase === "done") log(`gen ${g.gen}: ${g.accepted ? "accepted" : "rejected"} (${g.reason})`);
    } catch (e) {
      // A failed shell step (ShellError) carries the command's stderr, which the message alone omits.
      const stderr = (e as { stderr?: Buffer }).stderr?.toString().trim();
      g.error = `${e instanceof Error ? e.message : String(e)}${stderr ? `: ${stderr.slice(-500)}` : ""}`;
      log(`gen ${g.gen}: ${g.error}; retrying in ${RETRY_MS / 60_000} min`);
      save();
      await Bun.sleep(RETRY_MS);
    }
    save();
  }
  log("generation limit reached");
  releasePid();
}

if (import.meta.main) await main().catch(e => {
  log(`stopped: ${e instanceof Error ? e.message : String(e)}`);
  releasePid();
  process.exit(1);
});
