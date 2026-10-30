// Readable traces of an evaluated question for the RSI improver: every tool call each agent made, with its
// arguments, result size, errors, and the prompt size at that step, plus how the agent managed its context (CLM).
// Calls replaced by context_edit are recovered from episode_history, and results from ops.
import { Database } from "bun:sqlite";
import type { AssistantMessage, Message, ToolCall } from "@earendil-works/pi-ai";
import { tools } from "../src/tools.ts";

type Call = { name: string; args: string; tokens: number; chars: number; error?: string; result: string };
type Episode = { id: string; agent: string; task: string; kind: string; status: string; calls: Call[]; nudges: number; peak: number };
export type Stats = {
  sample: string; score?: number; episodes: Episode[]; memoryWrites: Record<string, number>; memoryChars: Record<string, number>;
  agents: number; peak: number;
};

const NUDGE = "Continue with tools.";
const clip = (s: string, n: number) => s.length > n ? `${s.slice(0, n)}…` : s;
const num = (n: number) => n.toLocaleString("en-US");
const prompt = (m: AssistantMessage) => m.usage ? m.usage.input + m.usage.cacheRead + m.usage.cacheWrite : 0;

export function collect(dbPath: string, sample: string, score?: number): Stats {
  const db = new Database(dbPath, { readonly: true });
  try {
    const kinds = new Map((db.query("select id, kind from tasks").all() as { id: string; kind: string }[]).map(t => [t.id, t.kind]));
    const ops = new Map((db.query("select episode, call_id, result, is_error from ops").all() as { episode: string; call_id: string; result: string; is_error: number }[])
      .map(o => [`${o.episode}\t${o.call_id}`, o]));
    const episodes: Episode[] = (db.query("select rowid, * from episodes order by rowid").all() as { id: string; agent: string; task: string; messages: string; status: string }[]).map(e => {
      // Earlier snapshots hold the steps a context_edit later replaced; the final messages hold the rest.
      const snapshots = (db.query("select messages from episode_history where episode = ? order by at").all(e.id) as { messages: string }[]).map(h => JSON.parse(h.messages) as Message[]);
      const seen = new Set<string>(), calls: Call[] = [];
      let nudges = 0, peak = 0;
      for (const messages of [...snapshots, JSON.parse(e.messages) as Message[]]) for (const m of messages) {
        if (m.role !== "assistant") continue;
        const key = `${m.timestamp}`;
        if (seen.has(key)) continue;
        seen.add(key);
        peak = Math.max(peak, prompt(m));
        for (const c of m.content.filter((b): b is ToolCall => b.type === "toolCall")) {
          const op = ops.get(`${e.id}\t${c.id}`);
          calls.push({ name: c.name, args: JSON.stringify(c.arguments), tokens: prompt(m), chars: op?.result.length ?? 0, error: op?.is_error ? op.result : undefined, result: op?.result ?? "" });
        }
      }
      for (const messages of [...snapshots, JSON.parse(e.messages) as Message[]]) nudges = Math.max(nudges, messages.filter(m => m.role === "user" && typeof m.content === "string" && m.content.startsWith(NUDGE)).length);
      return { id: e.id, agent: e.agent, task: e.task, kind: kinds.get(e.task) ?? "?", status: e.status, calls, nudges, peak };
    });
    const memoryWrites = Object.fromEntries((db.query("select agent, count(*) n from context_history group by agent").all() as { agent: string; n: number }[]).map(r => [r.agent, r.n]));
    const memoryChars = Object.fromEntries((db.query("select agent, length(memory) n from context").all() as { agent: string; n: number }[]).map(r => [r.agent, r.n]));
    const agents = (db.query("select count(*) n from agents").get() as { n: number }).n;
    return { sample, score, episodes, memoryWrites, memoryChars, agents, peak: Math.max(0, ...episodes.map(e => e.peak)) };
  } finally {
    db.close();
  }
}

export function traceMarkdown(s: Stats) {
  const lines = [`# ${s.sample}${s.score === undefined ? "" : ` — score ${s.score}`}`, "",
    `Agents: ${s.agents}. Peak prompt: ${num(s.peak)} tokens. Working memory: ${Object.keys(s.memoryChars).map(a => `${a} ${s.memoryChars[a]} chars after ${s.memoryWrites[a] ?? 0} writes`).join("; ")}.`];
  for (const e of s.episodes) {
    lines.push("", `## ${e.task} (${e.kind}) by ${e.agent} — ${e.status}, ${e.calls.length} calls, peak ${num(e.peak)} tokens${e.nudges ? `, ${e.nudges} nudges to continue` : ""}`);
    e.calls.forEach((c, i) => lines.push(`${i + 1}. [${num(c.tokens)}] ${c.name} ${clip(c.args, 160)} → ${c.error ? `ERROR ${clip(c.error, 160)}` : `${num(c.chars)} chars: ${clip(c.result.replace(/\s+/g, " "), 100)}`}`));
  }
  return `${lines.join("\n")}\n`;
}

// Across questions: how tools were used and how agents managed their context.
export function diagnosticsMarkdown(all: Stats[]) {
  const calls = all.flatMap(s => s.episodes.flatMap(e => e.calls.map(c => ({ ...c, sample: s.sample, episode: e.id }))));
  const byTool = new Map<string, typeof calls>();
  for (const c of calls) byTool.set(c.name, [...byTool.get(c.name) ?? [], c]);
  const unused = Object.keys(tools).filter(t => !byTool.has(t));
  const repeats = all.flatMap(s => s.episodes.flatMap(e => {
    const n = new Map<string, number>();
    for (const c of e.calls) n.set(`${c.name} ${c.args}`, (n.get(`${c.name} ${c.args}`) ?? 0) + 1);
    return [...n].filter(([, k]) => k > 1).map(([call, k]) => `- ${s.sample} ${e.task}: ${k}× ${clip(call, 140)}`);
  }));
  const empty = calls.filter(c => !c.error && /^(No matches|No knowledge|Empty|No domains)/.test(c.result));
  const errors = calls.filter(c => c.error);
  const episodes = all.flatMap(s => s.episodes);
  const outcomes = episodes.reduce<Record<string, number>>((o, e) => (o[e.status] = (o[e.status] ?? 0) + 1, o), {});
  const mean = (xs: number[]) => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
  return [
    "# Diagnostics across evaluated questions", "",
    "## Tool use", "",
    "| tool | calls | errors | mean result chars | questions |", "| --- | --- | --- | --- | --- |",
    ...[...byTool].sort((a, b) => b[1].length - a[1].length).map(([t, cs]) =>
      `| ${t} | ${cs.length} | ${cs.filter(c => c.error).length} | ${num(mean(cs.map(c => c.chars)))} | ${new Set(cs.map(c => c.sample)).size} |`),
    "", `Never called (some tools are withheld from some roles): ${unused.join(", ") || "none"}.`,
    "", `### Errors (${errors.length})`, ...errors.slice(0, 20).map(c => `- ${c.sample} ${c.name}: ${clip(c.error!, 200)}`),
    "", `### Lookups that found nothing (${empty.length})`, ...empty.slice(0, 20).map(c => `- ${c.sample} ${c.name} ${clip(c.args, 140)}`),
    "", `### Identical calls repeated in one episode (${repeats.length})`, ...repeats.slice(0, 20),
    "", "## Context management (CLM)", "",
    `Episode outcomes: ${Object.entries(outcomes).map(([k, v]) => `${k} ${v}`).join(", ")}. Nudged to continue: ${episodes.filter(e => e.nudges).length} of ${episodes.length} episodes.`,
    `context_edit calls: ${byTool.get("context_edit")?.length ?? 0}; memory_write/memory_edit calls: ${(byTool.get("memory_write")?.length ?? 0) + (byTool.get("memory_edit")?.length ?? 0)}.`,
    "", "| question | score | agents | episodes | calls | peak tokens | context_edit | memory writes | final memory chars |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...all.map(s => {
      const cs = s.episodes.flatMap(e => e.calls);
      return `| ${s.sample} | ${s.score ?? "-"} | ${s.agents} | ${s.episodes.length} | ${cs.length} | ${num(s.peak)} | ${cs.filter(c => c.name === "context_edit").length} | ${Object.values(s.memoryWrites).reduce((a, b) => a + b, 0)} | ${Object.values(s.memoryChars).reduce((a, b) => a + b, 0)} |`;
    }),
    "",
  ].join("\n");
}
