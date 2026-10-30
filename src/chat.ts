import { validateToolCall, type AssistantMessage, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { MODEL_TIMEOUT_MS, withTimeout } from "./agent.ts";
import { defaultConfig, Store, type Agent, type Task } from "./db.ts";
import type { Llm } from "./locomo.ts";
import { rememberTurns, type Turn } from "./memory.ts";
import { tools, type ToolContext } from "./tools.ts";
import { emit } from "./triggers.ts";
import { runScheduler } from "./scheduler.ts";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Front chat: the model that talks to the user keeps only the last few messages in its context. Older messages are
// handed to DeLM as knowledge (one sentence per item, one domain per day), and the model looks them up when a reply
// needs them. The chat log itself stays in the store for display, never in the model's context.
// Each domain has a steward agent; as memory accumulates, a trigger sets the steward to organize its domain, and
// organize() runs those tasks after a reply.

export const WINDOW = 6;
const MAX_STEPS = 8;
const LOOKUP = ["domain_list", "knowledge_search", "knowledge_get"];

const SYSTEM = `You are the front of a conversation with a user. You see only the last ${WINDOW} messages; everything earlier is in memory.
Memory holds every earlier message, split into sentences, one domain per day (domain_list shows them). When the user refers to anything said before, or a reply depends on what you know about the user, look it up with knowledge_search (words to match) and knowledge_get (summary is the whole message, raw adds the messages around it) before answering.
Do not claim to remember something you did not find. Reply in the user's language.`;

export type ChatMessage = { id: number; role: "user" | "assistant"; text: string; at: number; remembered: number };
export type ChatReply = { reply: string; calls: number; lookups: number; peakTokens: number; remembered: number };

export function openChat(path: string) {
  const store = new Store(path);
  store.db.exec("create table if not exists chat(id integer primary key, role text not null, text text not null, at int not null, remembered int not null default 0)");
  // The store's purpose and lead agent let DeLM agents organize the same memory later.
  store.init("Keep the memory of a conversation with a user organized so the front chat can find what it needs.", "", defaultConfig);
  // The chat never finishes: G0 stays in review, so it is never steered or verified and only triggered work runs.
  store.run("update goals set status = 'review' where id = 'G0' and status = 'open'");
  return store;
}

export const history = (store: Store) => store.all<ChatMessage>("select * from chat order by id");

const day = (at: number) => new Date(at).toISOString().slice(0, 10);
const turnOf = (m: ChatMessage): Turn => {
  const speaker = m.role === "user" ? "User" : "Assistant", when = new Date(m.at).toISOString().slice(0, 16).replace("T", " ");
  return { speaker, text: m.text, line: `${speaker}: ${m.text}`, when };
};

// Hands every message that fell out of the window to DeLM; returns how many were handed over.
export function rememberOld(store: Store) {
  const all = history(store), old = all.slice(0, Math.max(0, all.length - WINDOW)).filter(m => !m.remembered);
  for (const d of new Set(old.map(m => day(m.at)))) {
    const ofDay = all.filter(m => day(m.at) === d), domain = `D-chat-${d}`;
    const added = rememberTurns(store, { id: domain, name: `Chat ${d}`, description: `Messages with the user on ${d}` },
      ofDay.map(turnOf), ofDay.flatMap((m, i) => old.includes(m) ? [i] : []), i => `c${ofDay[i]!.id}`);
    store.tx(() => emit(store, "front", "memory_grown", { domain, added }));
  }
  for (const m of old) store.run("update chat set remembered = 1 where id = ?", m.id);
  return old.length;
}

export async function reply(llm: Llm, store: Store, text: string): Promise<ChatReply> {
  store.run("insert into chat(role, text, at) values('user', ?, ?)", text, Date.now());
  const remembered = rememberOld(store);
  const recent = history(store).slice(-WINDOW);
  const messages: Message[] = [{
    role: "user", timestamp: Date.now(),
    content: `${recent.length > 1 ? `Recent messages:\n${recent.slice(0, -1).map(m => turnOf(m).line).join("\n")}\n\n` : ""}New message from the user (${turnOf(recent.at(-1)!).when} UTC):\n${text}`,
  }];
  const schemas = LOOKUP.map(name => ({ name, description: tools[name]!.description, parameters: tools[name]!.parameters }));
  // Lookup tools read only the store; the agent and task are placeholders for the shared tool signature.
  const ctx = { store, agent: { id: "front" } as Agent, task: { id: "chat" } as Task, workspace: "", contextDir: "", episode: "chat", messages } as ToolContext;
  let calls = 0, lookups = 0, peakTokens = 0, answer = "";
  for (let step = 0; step < MAX_STEPS && !answer; step++) {
    const started = performance.now();
    const r: AssistantMessage = await withTimeout(MODEL_TIMEOUT_MS, signal =>
      llm.models.completeSimple(llm.model, { systemPrompt: SYSTEM, messages, tools: step < MAX_STEPS - 1 ? schemas : [] }, { reasoning: llm.reasoning, sessionId: "front", signal }));
    if (r.stopReason === "error" || r.stopReason === "aborted") throw new Error(`Model error: ${r.errorMessage}`);
    const u = r.usage;
    calls++;
    peakTokens = Math.max(peakTokens, u.input + u.cacheRead + u.cacheWrite);
    store.run("insert into usage(agent, task, input, output, cache_read, cache_write, prompt_chars, ms, at) values('front', 'chat', ?, ?, ?, ?, ?, ?, ?)",
      u.input, u.output, u.cacheRead, u.cacheWrite, SYSTEM.length + JSON.stringify(messages).length, Math.round(performance.now() - started), Date.now());
    messages.push(r);
    const toolCalls = r.content.filter((b): b is ToolCall => b.type === "toolCall");
    if (!toolCalls.length) { answer = r.content.filter(b => b.type === "text").map(b => b.text).join("").trim(); break; }
    for (const call of toolCalls) {
      let out: string, isError = false;
      try {
        if (!LOOKUP.includes(call.name)) throw new Error(`Unknown tool ${call.name}`);
        out = String(await tools[call.name]!.run(ctx, validateToolCall(schemas, call)));
        lookups++;
      } catch (e) { out = `Error: ${e instanceof Error ? e.message : String(e)}`; isError = true; }
      messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: out.slice(0, defaultConfig.toolOutputLimit) }], isError, timestamp: Date.now() });
    }
  }
  answer ||= "(no reply)";
  store.run("insert into chat(role, text, at) values('assistant', ?, ?)", answer, Date.now());
  return { reply: answer, calls, lookups, peakTokens, remembered };
}

// Runs the organizing work the triggers created (stewards splitting, merging, or handing over domains), with a
// bounded number of rounds; each organize task also has its own call budget.
export async function organize(llm: Llm, store: Store, dir: string, rounds = 6) {
  if (!store.get("select 1 from tasks where kind = 'organize' and status in ('open', 'claimed')")) return undefined;
  mkdirSync(join(dir, "workspace"), { recursive: true });
  return runScheduler({ store, ...llm, workspace: join(dir, "workspace"), contextDir: join(dir, "contexts") }, rounds);
}
