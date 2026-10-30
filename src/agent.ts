import { validateToolCall, type Api, type AssistantMessage, type Message, type Model, type ThinkingLevel, type Tool, type ToolCall } from "@earendil-works/pi-ai";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { Agent, Store, Task } from "./db.ts";
import { mirror, toolSchemas, tools, type ToolContext } from "./tools.ts";

export type Runtime = {
  store: Store;
  models: ReturnType<typeof createModels>;
  model: Model<Api>;
  reasoning?: ThinkingLevel;
  workspace: string;
  contextDir: string;
  log?: (line: string) => void;
  modelTimeoutMs?: number;
};

// A provider connection that never answers would otherwise hold the whole run; a timed-out call counts as a model error.
export const MODEL_TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS ?? 300_000);

// Aborts the request and also stops waiting, so a provider that ignores the abort signal cannot hang the caller.
export async function withTimeout<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error(`Model call timed out after ${ms} ms`)); }, ms);
  });
  try { return await Promise.race([call(controller.signal), timeout]); } finally { clearTimeout(timer); }
}

export class BudgetExhausted extends Error {}

// Live context size (characters) above which tool results ask the agent to compact.
const COMPACT_AT = 60_000;

// Stable per agent: no clocks, counters, or shared state, so the provider can reuse the cached prefix.
export function systemPrompt(store: Store, agent: Agent) {
  const c = store.config;
  return `You are agent "${agent.id}" in an autonomous multi-agent organization.
Role: ${agent.role}
Top-level purpose (fixed; you may reinterpret how to reach it, never what it is): ${store.purpose}
Constraints: ${store.meta("constraints") || "none"}
Organization: ${c.organization} mode, ${Number.isFinite(c.maxAgents) ? `at most ${c.maxAgents}` : "no limit on the number of"} agents. Shell access: ${c.allowShell ? "granted" : "not granted"}.

How you work:
- You handle one claimed task at a time. Shared goals, tasks, knowledge, domains, and other agents are visible only through tools; look up only what the task needs.
- Progress means real, checkable artifacts in the workspace (file_write, shell when granted). Planning alone is not progress. Doing the work directly is often best; split it with goal_create/task_create only when that helps.
- Deliverables go in files; facts with their sources go in knowledge. web_search results are recorded as knowledge automatically (their IDs are shown), so run knowledge_search before searching the web again, and cite knowledge IDs for the claims your deliverables rely on. Record other findings worth reusing with knowledge_add, citing the source. New knowledge is a hypothesis until verified; never state unverified claims as fact.
- Your working memory is the only thing you carry between tasks. Before finishing, update it if something should carry over: memory_edit changes a part, memory_write replaces it all. Keep it short and point to knowledge IDs and files instead of copying them.
- Another agent verifies your results. When you verify, inspect the artifacts yourself and fail anything that is not demonstrated.
- Change the organization (spawn, sleep, reassign, transfer, split or merge domains) only when the expected benefit clearly exceeds its cost; keeping the current structure is a valid choice.
- Your live context for a task is yours to edit. Each tool result ends with its message number and the context size. Once steps are digested, replace them with context_edit: from the tool call that started them to the message that concluded them, with a short note of what they established. Use news to see what other agents did since you last looked.
- End every task with task_finish or task_release.`;
}

function openingMessage(store: Store, agent: Agent, task: Task) {
  const memory = store.memory(agent.id)!;
  const unread = store.get<{ n: number }>("select count(*) n from log where id > ? and (agent is null or agent != ?)", Number(store.meta(`cursor:${agent.id}`) ?? 0), agent.id)!.n;
  const chain: string[] = [];
  for (let g = store.goal(task.goal); g; g = g.parent ? store.goal(g.parent) : undefined) chain.push(`${g.id}: ${g.description}`);
  return `## Your working memory (v${memory.version})
${memory.memory || "(empty)"}

## Current task ${task.id} (${task.kind}, from ${task.author})
${task.description}
${task.feedback ? `\nNote from a previous attempt or verification: ${task.feedback}\n` : ""}
Goal chain: ${chain.join(" <- ")}
Unread updates from other agents: ${unread} (see news)`;
}

const toolCalls = (m: Message) => m.role === "assistant" ? m.content.filter((b): b is ToolCall => b.type === "toolCall") : [];

async function execute(rt: Runtime, ctx: ToolContext, episode: string, call: ToolCall, schemas: Tool[]) {
  const { store } = rt;
  // A tool call that already ran (before a crash) returns its recorded result instead of running again.
  const prior = store.get<{ result: string; is_error: number }>("select result, is_error from ops where episode = ? and call_id = ?", episode, call.id);
  if (prior) return { text: prior.result, isError: prior.is_error === 1 };
  let text: string, isError = false;
  try {
    const def = tools[call.name];
    if (!def || !schemas.some(s => s.name === call.name)) throw new Error(`Unknown tool ${call.name}`);
    const args = validateToolCall(schemas, call);
    // Database tools commit together with their op record; file and shell tools run outside the transaction.
    const value = store.tx(() => {
      const v = def.run(ctx, args);
      if (!(v instanceof Promise)) store.run("insert into ops(episode, call_id, result, is_error) values(?, ?, ?, 0)", episode, call.id, v);
      return v;
    });
    text = await value;
    if (value instanceof Promise) store.run("insert into ops(episode, call_id, result, is_error) values(?, ?, ?, 0)", episode, call.id, text);
  } catch (e) {
    text = `Error: ${e instanceof Error ? e.message : String(e)}`;
    isError = true;
    store.run("insert or ignore into ops(episode, call_id, result, is_error) values(?, ?, ?, 1)", episode, call.id, text);
  }
  const limit = store.config.toolOutputLimit;
  if (text.length > limit) text = `${text.slice(0, limit)}\n[truncated ${text.length - limit} chars; request a smaller range]`;
  return { text, isError };
}

// Runs (or resumes) one agent's work on one claimed task. Messages are persisted after every step.
export async function runEpisode(rt: Runtime, agent: Agent, task: Task) {
  const { store } = rt;
  const id = `${task.id}:${agent.id}:${task.rev}`;
  const saved = store.get<{ messages: string }>("select messages from episodes where id = ?", id);
  const messages: Message[] = saved ? JSON.parse(saved.messages) : [{ role: "user", content: openingMessage(store, agent, task), timestamp: Date.now() }];
  if (!saved) store.run("insert into episodes(id, agent, task, messages, status) values(?, ?, ?, ?, 'running')", id, agent.id, task.id, JSON.stringify(messages));
  const save = () => { store.run("update episodes set messages = ? where id = ?", JSON.stringify(messages), id); mirror(rt, agent.id); };
  const end = (outcome: string) => { store.run("update episodes set status = ? where id = ?", outcome, id); mirror(rt, agent.id); return outcome; };
  const ctx: ToolContext = { store, agent, task, workspace: rt.workspace, contextDir: rt.contextDir, episode: id, messages };
  const system = systemPrompt(store, agent);
  const schemas = toolSchemas();
  const { maxSteps } = store.config;
  let nudged = false;

  for (;;) {
    const last = messages.at(-1)!;
    const answered = new Set(messages.filter(m => m.role === "toolResult").map(m => m.toolCallId));
    for (const call of toolCalls(last).filter(c => !answered.has(c.id))) {
      const r = await execute(rt, ctx, id, call, schemas);
      rt.log?.(`[${agent.id}] ${call.name}${r.isError ? " ✗" : ""} ${r.text.split("\n")[0]!.slice(0, 120)}`);
      // As in the CLM reference harness, every result shows where it sits and how large the context is, and asks for compaction past a threshold.
      const size = system.length + JSON.stringify(messages).length + r.text.length;
      const readout = `[#${messages.length} · live context: ~${size} chars${size > COMPACT_AT ? ` — over ${COMPACT_AT}; replace digested steps with context_edit now` : ""}]`;
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `${r.text}\n${readout}` }], isError: r.isError, timestamp: Date.now() });
      save();
    }
    const current = store.task(task.id)!;
    if (current.status !== "claimed" || current.claimed_by !== agent.id) return end(current.status === "open" ? "released" : "finished");

    const steps = messages.filter(m => m.role === "assistant").length;
    if (last.role === "assistant" && !toolCalls(last).length) {
      if (nudged) {
        store.run("update tasks set status = 'open', claimed_by = null, lease_until = null, feedback = 'previous attempt stopped without finishing', rev = rev + 1 where id = ?", task.id);
        return end("released");
      }
      nudged = true;
      messages.push({ role: "user", content: "Continue with tools. End the task with task_finish or task_release.", timestamp: Date.now() });
    }
    if (steps >= maxSteps) {
      store.run("update tasks set status = 'open', claimed_by = null, lease_until = null, feedback = 'step limit reached; check the previous agent''s working memory', rev = rev + 1 where id = ?", task.id);
      return end("step_limit");
    }
    if (steps === maxSteps - 2) messages.push({ role: "user", content: "Two steps remain. Save progress with memory_write, then task_finish or task_release.", timestamp: Date.now() });

    if (!store.takeModelCall()) throw new BudgetExhausted("Model call budget exhausted");
    store.renew(task.id, agent.id);
    const started = performance.now();
    const reply: AssistantMessage = await withTimeout(rt.modelTimeoutMs ?? MODEL_TIMEOUT_MS, signal =>
      rt.models.completeSimple(rt.model, { systemPrompt: system, messages, tools: schemas }, { reasoning: rt.reasoning, sessionId: agent.id, signal }));
    const u = reply.usage;
    store.run("insert into usage(agent, task, input, output, cache_read, cache_write, prompt_chars, ms, at) values(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      agent.id, task.id, u.input, u.output, u.cacheRead, u.cacheWrite, system.length + JSON.stringify(messages).length, Math.round(performance.now() - started), Date.now());
    if (reply.stopReason === "error" || reply.stopReason === "aborted") throw new Error(`Model error: ${reply.errorMessage}`);
    messages.push(reply);
    save();
  }
}
