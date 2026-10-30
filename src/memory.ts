import type { Store } from "./db.ts";

// Conversation handed to DeLM: each turn is split into sentences, each sentence recorded as verified knowledge in the
// domain of its session, so an agent keeps no conversation in its context and looks up only what it needs.
// ponytail: splitting at sentence punctuation; a splitter model is the alternative to compare against.

export const MEMORY_GUIDE = "The conversation is not in the workspace. It was split into sentences and stored as verified knowledge, one domain per session (domain_list shows each session's date). Find what you need with knowledge_search (words; optionally within one domain) and knowledge_get (summary is the whole turn, raw adds the turns around it).";

export const splitSentences = (text: string) => text.split(/(?<=[。！？])\s*|(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);

// when labels the turn's time (a session date or a timestamp); line is the turn as shown in raw evidence.
export const stewardOf = (domain: string) => `steward-${domain.toLowerCase()}`;
export const isSteward = (agent: string) => agent.startsWith("steward-");

export type Turn = { speaker: string; text: string; line: string; when: string };

// Records turns[i] for each i in pick; raw evidence takes the neighbouring turns from the whole list.
// The domain is created on first use with a steward of its own, dormant until a trigger gives it organizing work;
// key(i) must be unique per turn across the store.
export function rememberTurns(store: Store, domain: { id: string; name: string; description: string }, turns: Turn[], pick: number[], key: (i: number) => string) {
  const now = Date.now();
  let n = 0;
  store.tx(() => {
    if (!store.get("select 1 from domains where id = ?", domain.id)) {
      const steward = stewardOf(domain.id);
      if (!store.agent(steward)) {
        store.addAgent(steward, `steward of domain ${domain.id} (${domain.name}): keeps its knowledge organized so it can be found`, "host");
        store.run("update agents set status = 'dormant' where id = ?", steward);
      }
      store.run("insert into domains(id, name, description, steward, status) values(?, ?, ?, ?, 'active')", domain.id, domain.name, domain.description, steward);
    }
    for (const i of pick) {
      const t = turns[i]!, when = t.when ? `[${t.when}] ` : "";
      const around = turns.slice(Math.max(0, i - 2), i + 3).map(x => x.line).join("\n");
      splitSentences(t.text).forEach((sentence, k) => {
        const id = `K-${key(i)}-${k + 1}`;
        store.run("insert into knowledge(id, gist, summary, raw, source, status, author, verified_by, created_at) values(?, ?, ?, ?, ?, 'verified', 'ingest', 'ingest', ?)",
          id, `${when}${t.speaker ? `${t.speaker}: ` : ""}${sentence}`, `${when}${t.line}`, `${when}\n${around}`, `${domain.name} turn ${i + 1}`, now);
        store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain.id, id);
        n++;
      });
    }
  });
  return n;
}

// LoCoMo sessions start with "DATE: ..." and hold lines like `Name said, "..."`; a stitched LoCoMo-Plus conversation has no dates.
function sessions(conversation: string) {
  const out: { date: string; turns: Turn[] }[] = [];
  for (const line of conversation.split("\n").map(l => l.trim()).filter(Boolean)) {
    const date = /^DATE:\s*(.*)$/.exec(line);
    if (date) { out.push({ date: date[1]!, turns: [] }); continue; }
    if (line === "CONVERSATION:") continue;
    if (!out.length) out.push({ date: "", turns: [] });
    const s = out.at(-1)!, m = /^(.+?) said, "(.*)"(.*)$/.exec(line);
    s.turns.push(m ? { speaker: m[1]!, text: `${m[2]}${m[3] ? ` (${m[3].trim()})` : ""}`, line, when: s.date } : { speaker: "", text: line, line, when: s.date });
  }
  return out.filter(s => s.turns.length);
}

// Returns the number of knowledge items recorded.
export function ingestConversation(store: Store, conversation: string) {
  return sessions(conversation).reduce((n, s, si) => n + rememberTurns(store,
    { id: `D-s${si + 1}`, name: `Session ${si + 1}`, description: s.date ? `Conversation on ${s.date}` : "Conversation" },
    s.turns, s.turns.map((_, i) => i), i => `s${si + 1}-${i + 1}`), 0);
}
