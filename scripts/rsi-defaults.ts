// Default settings of the RSI loop (scripts/rsi.ts), shared with the dashboard so its form starts from the same values.
import { HARNESS_ARMS } from "../src/locomo.ts";
export const PURPOSE = `Improve the hypharness agent harness whose source is this workspace (a git checkout of the harness that is running you).
Objective: when the harness answers a fixed LoCoMo-Plus subset, raise the judge score and lower the peak prompt tokens per question.

Evidence from the current harness is in rsi-traces/:
- eval.json: score, per-question scores, context sizes, and how concentrated the work was (lead's share of calls, agents).
- diagnostics.md: across questions, every tool's calls, errors and result sizes, tools never called, lookups that found nothing, identical calls repeated, episode outcomes, and per question the peak prompt, context_edit calls and working-memory writes.
- locomo/<arm>/<sample>/trace.md: each agent's episodes call by call, with arguments, result size or error, and the prompt size at that step.
- locomo/<arm>/<sample>/contexts/*.md: each agent's final working memory and live context.
- locomo/judgments.jsonl and predictions.jsonl: answers and the judge's reasons.
- history.md: earlier generations, their changes, predictions and measured effects. Do not repeat a change that already failed.

Diagnose before changing anything. Start from questions that lost points and the ones with the largest peaks, and check:
1. CLM (each agent's persistent context): Does working memory carry what the next task needs, short, with pointers to knowledge and files instead of copies? Do agents replace digested steps with context_edit, or does the live context only grow until the step limit? Do episodes end with step_limit, released, or nudges to continue instead of finishing?
2. Tool use: Are the right tools called with good arguments? Look for errors, empty lookups, identical calls repeated, results far larger than needed, and tools that would have found the answer but were never called. Check whether tool descriptions, result formats or limits cause it.
3. Organization (DeLM): Are agents, tasks and verification used where they help, or do they add calls without catching mistakes? Is the work concentrated on lead?
4. Answers: For each wrong answer, find where it went wrong: evidence never found, found but misread (dates, people), or the answer not written as asked.
5. Context length: The harness's principle is that no agent's context grows long. For each large peak, find in trace.md the call where the prompt jumped and what caused it: a large tool result kept in context, steps never compacted, a long working memory, or a long opening message. Prefer changes that keep only what the next step needs.
6. Memory (arms ending in -memory, the conversation held in DeLM): Do lookups reach the evidence in a few calls, or do they miss and retry? Would a different split of the conversation, search, or domain layout have found it?
7. Market roles (mode market): Do the investor's budgets match what the work spent, are declines and re-splits wasting calls, and are the critic's objections upheld or overruled?
Checks 6 and 7 apply only when the evaluated arm uses them.

Then make one focused change to the harness source that addresses the most frequent cause you found. bun run check and bun test must pass; add a test for the change.
Before finishing, write rsi-traces/note.md: the diagnosis (which check failed, in which questions, with call-level evidence), what you changed and why, and the effect you predict on score and peak tokens.`;
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
  if (!["single", "fixed", "dynamic", "market"].includes(next.mode!)) throw new Error("--mode must be single, fixed, dynamic, or market");
  if (!(HARNESS_ARMS as readonly string[]).includes(next.arm!)) throw new Error(`--arm must be one of ${HARNESS_ARMS.join(", ")}`);
  if (!["on", "off"].includes(next.judges!)) throw new Error("--judges must be on or off");
  for (const key of ["calls", "evalCalls", "perCategory", "parallel", "generations"])
    if (next[key] !== undefined && !/^[1-9]\d*$/.test(next[key]!)) throw new Error(`--${flag(key)} must be a positive integer`);
  if (!/^(0(\.\d+)?|1(\.0+)?)$/.test(next.delta!)) throw new Error("--delta must be between 0 and 1");
  if (!next.purpose!.trim()) throw new Error("--purpose must not be empty");
  return next as RsiSettings;
}
