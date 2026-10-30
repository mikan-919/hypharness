import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Harness runs started from the dashboard. Each run is a child process of `src/index.ts` with its own --dir;
// the harness state lives in that directory, so a stopped run resumes from the same state.

export type RsiRequest = { calls?: number; generations?: number; perCategory?: number; seed?: number; delta?: number };

export type RunRequest = {
  kind: "run" | "bench";
  purpose?: string; constraints?: string; mode?: string;
  calls?: number; agents?: number; concurrency?: number; rounds?: number;
  allowShell?: boolean; check?: string;
};

type Run = {
  dir: string; kind: RunRequest["kind"] | "rsi"; args: string[]; startedAt: number; endedAt: number | null;
  exitCode: number | null; output: string[]; proc: ReturnType<typeof Bun.spawn>;
};

const entry = resolve(import.meta.dir, "..", "index.ts");
const rsiEntry = resolve(import.meta.dir, "..", "..", "scripts", "rsi.ts");
const runs = new Map<string, Run>();
const MAX_LINES = 1000;

const positive = (v: unknown, name: string) => {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`);
  return String(v);
};

// Translates a validated request into CLI flags; the harness applies the same checks again.
export function harnessArgs(r: RunRequest, dir: string, resume: boolean) {
  if (r.kind !== "run" && r.kind !== "bench") throw new Error("kind must be run or bench");
  const purpose = typeof r.purpose === "string" ? r.purpose.trim() : "";
  if (!resume && !purpose) throw new Error("purpose is required");
  if (r.mode !== undefined && !["single", "fixed", "dynamic"].includes(r.mode)) throw new Error("mode must be single, fixed, or dynamic");
  const args = r.kind === "bench" ? ["bench", purpose] : resume ? [] : [purpose];
  const flags: [string, string | undefined][] = [
    ["--dir", dir], ["--calls", positive(r.calls, "calls")], ["--agents", positive(r.agents, "agents")],
    ["--concurrency", positive(r.concurrency, "concurrency")], ["--rounds", positive(r.rounds, "rounds")],
    ["--constraints", typeof r.constraints === "string" && r.constraints.trim() ? r.constraints.trim() : undefined],
    ["--mode", resume ? undefined : r.mode], ["--check", typeof r.check === "string" && r.check.trim() ? r.check.trim() : undefined],
  ];
  for (const [flag, value] of flags) if (value !== undefined) args.push(flag, value);
  if (r.allowShell === true) args.push("--allow-shell");
  return args;
}

async function pump(run: Run, stream: ReadableStream<Uint8Array>, log: string) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      run.output.push(line);
      appendFileSync(log, `${line}\n`);
    }
    if (run.output.length > MAX_LINES) run.output.splice(0, run.output.length - MAX_LINES);
  }
  if (rest) { run.output.push(rest); appendFileSync(log, `${rest}\n`); }
}

// ponytail: one host process per directory is enforced only for runs started here; a CLI run on the same dir is not detected
export function start(dir: string, request: RunRequest, resume: boolean) {
  if (runs.get(dir)?.endedAt === null) throw new Error(`${dir} is already running`);
  if (!resume && existsSync(join(dir, "state.sqlite"))) throw new Error(`${dir} already has a session; resume it instead`);
  if (resume && !existsSync(join(dir, "state.sqlite"))) throw new Error(`${dir} has no session to resume`);
  return spawn(dir, request.kind, entry, harnessArgs(request, dir, resume), "run.log");
}

// The loop writes its own rsi.log; the launcher log keeps what the process printed, including a crash.
export function startRsi(dir: string, r: RsiRequest) {
  if (runs.get(dir)?.endedAt === null) throw new Error(`${dir} is already running`);
  const args = ["--dir", dir];
  for (const [flag, value] of [["--calls", r.calls], ["--generations", r.generations], ["--per-category", r.perCategory]] as const) {
    const v = positive(value, flag.slice(2));
    if (v !== undefined) args.push(flag, v);
  }
  if (r.seed !== undefined && r.seed !== null) {
    if (typeof r.seed !== "number" || !Number.isSafeInteger(r.seed)) throw new Error("seed must be an integer");
    args.push("--seed", String(r.seed));
  }
  if (r.delta !== undefined && r.delta !== null) {
    if (typeof r.delta !== "number" || !(r.delta >= 0 && r.delta <= 1)) throw new Error("delta must be between 0 and 1");
    args.push("--delta", String(r.delta));
  }
  return spawn(dir, "rsi", rsiEntry, args, "launcher.log");
}

function spawn(dir: string, kind: Run["kind"], script: string, args: string[], logName: string) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, logName);
  appendFileSync(log, `\n=== ${new Date().toISOString()} bun ${[script, ...args].join(" ")}\n`);
  const proc = Bun.spawn(["bun", script, ...args], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe", env: process.env });
  const run: Run = { dir, kind, args, startedAt: Date.now(), endedAt: null, exitCode: null, output: [], proc };
  runs.set(dir, run);
  const streams = [pump(run, proc.stdout as ReadableStream<Uint8Array>, log), pump(run, proc.stderr as ReadableStream<Uint8Array>, log)];
  proc.exited.then(async code => {
    await Promise.allSettled(streams);
    run.exitCode = code;
    run.endedAt = Date.now();
    appendFileSync(log, `=== exited with ${code}\n`);
  });
  return describe(run);
}

// Killing is safe for the harness state: tool calls are recorded per episode and running episodes resume on restart.
export function stop(dir: string) {
  const run = runs.get(dir);
  if (!run || run.endedAt !== null) throw new Error(`${dir} is not running`);
  run.proc.kill("SIGTERM");
  return describe(run);
}

const describe = (r: Run) => ({ dir: r.dir, kind: r.kind, args: r.args, startedAt: r.startedAt, endedAt: r.endedAt, exitCode: r.exitCode, running: r.endedAt === null });

export const list = () => [...runs.values()].map(describe);

export function output(dir: string) {
  const run = runs.get(dir);
  return run && { ...describe(run), lines: run.output };
}

// Children write to pipes owned by this server, so they are stopped with it and resumed later.
export function stopAll() {
  for (const r of runs.values()) if (r.endedAt === null) r.proc.kill("SIGTERM");
}
