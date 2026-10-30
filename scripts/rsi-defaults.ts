// Default settings of the RSI loop (scripts/rsi.ts), shared with the dashboard so its form starts from the same values.
export const PURPOSE = `Improve the hypharness agent harness whose source is this workspace (a git checkout of the harness that is running you).
Objective: when the harness answers a fixed LoCoMo-Plus subset, raise the judge score and lower the peak prompt tokens per question.
rsi-traces/ holds evidence from the current harness: eval.json (score, per-sample scores, context sizes), locomo/judgments.jsonl and predictions.jsonl, locomo/<arm>/<sample>/contexts/*.md (each agent's working memory and live context), and history.md (earlier generations, their predicted and measured effects).
Read the raw traces to find a cause, then make one focused change to the harness source. bun run check and bun test must pass.
Before finishing, write rsi-traces/note.md: what you changed, why, and the effect you predict on score and peak tokens.`;
export const CONSTRAINTS = "Edit only files inside the workspace. Do not modify src/locomo.ts, delete tests, or encode LoCoMo questions or answers. Never read or print auth.json or .env.";

export type RsiSettings = {
  purpose: string; constraints: string; mode: string; arm: string; judges: string; calls: string; evalCalls: string;
  perCategory: string; seed: string; delta: string; parallel?: string; generations?: string;
};

export const DEFAULTS: RsiSettings = {
  purpose: PURPOSE, constraints: CONSTRAINTS, mode: "dynamic", arm: "dynamic", judges: "on", calls: "150", evalCalls: "40", perCategory: "3", seed: "1", delta: "0.05",
};

// Every generation is compared with the incumbent on the same questions under the same budget, so these are fixed by the first start.
export const FIXED = ["perCategory", "seed", "evalCalls", "arm"] as const;

const flag = (key: string) => key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

// Resolves a start's settings from its CLI flags (`given`, keyed by flag name), the previous start's settings, and the defaults.
export function resolveSettings(prev: Partial<RsiSettings> | undefined, started: boolean, given: Record<string, string | boolean | undefined>): RsiSettings {
  const next: Record<string, string | undefined> = {};
  for (const key of Object.keys(DEFAULTS) as (keyof typeof DEFAULTS)[]) {
    const value = given[flag(key)] as string | undefined, before = prev?.[key] ?? DEFAULTS[key];
    const fixed = started && (FIXED as readonly string[]).includes(key);
    if (fixed && value !== undefined && value !== before) throw new Error(`--${flag(key)} is fixed at ${before} for this --dir; start a new --dir to change it`);
    next[key] = fixed ? before : value ?? before;
  }
  next.parallel = given.parallel as string | undefined;
  next.generations = given.generations as string | undefined;
  if (!["single", "fixed", "dynamic"].includes(next.mode!)) throw new Error("--mode must be single, fixed, or dynamic");
  if (!["dynamic", "memory"].includes(next.arm!)) throw new Error("--arm must be dynamic or memory");
  if (!["on", "off"].includes(next.judges!)) throw new Error("--judges must be on or off");
  for (const key of ["calls", "evalCalls", "perCategory", "parallel", "generations"])
    if (next[key] !== undefined && !/^[1-9]\d*$/.test(next[key]!)) throw new Error(`--${flag(key)} must be a positive integer`);
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(next.delta!)) throw new Error("--delta must be between 0 and 1");
  if (!next.purpose!.trim()) throw new Error("--purpose must not be empty");
  return next as RsiSettings;
}
