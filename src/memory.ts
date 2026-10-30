import type { Store } from "./db.ts";

// The answering agents keep no conversation in their context: the conversation is split into sentences and handed to
// DeLM as knowledge, one domain per session, and agents look up only what a question needs.
// ponytail: splitting at sentence punctuation; a splitter model is the alternative to compare against.

export const MEMORY_GUIDE = "The conversation is not in the workspace. It was split into sentences and stored as verified knowledge, one domain per session (domain_list shows each session's date). Find what you need with knowledge_search (words; optionally within one domain) and knowledge_get (summary is the whole turn, raw adds the turns around it).";

export const splitSentences = (text: string) => text.split(/(?<=[.!?。！？])\s+/).map(s => s.trim()).filter(Boolean);

type Turn = { speaker: string; text: string; line: string };

// LoCoMo sessions start with "DATE: ..." and hold lines like `Name said, "..."`; a stitched LoCoMo-Plus conversation has no dates.
function sessions(conversation: string) {
  const out: { date: string; turns: Turn[] }[] = [];
  for (const line of conversation.split("\n").map(l => l.trim()).filter(Boolean)) {
    const date = /^DATE:\s*(.*)$/.exec(line);
    if (date) { out.push({ date: date[1]!, turns: [] }); continue; }
    if (line === "CONVERSATION:") continue;
    if (!out.length) out.push({ date: "", turns: [] });
    const m = /^(.+?) said, "(.*)"(.*)$/.exec(line);
    out.at(-1)!.turns.push(m ? { speaker: m[1]!, text: `${m[2]}${m[3] ? ` (${m[3].trim()})` : ""}`, line } : { speaker: "", text: line, line });
  }
  return out.filter(s => s.turns.length);
}

// Returns the number of knowledge items recorded.
export function ingestConversation(store: Store, conversation: string) {
  const now = Date.now();
  let n = 0;
  store.tx(() => sessions(conversation).forEach((s, si) => {
    const domain = `D-s${si + 1}`, when = s.date ? `[${s.date}] ` : "";
    store.run("insert into domains(id, name, description, steward, status) values(?, ?, ?, 'lead', 'active')",
      domain, `Session ${si + 1}`, s.date ? `Conversation on ${s.date}` : "Conversation");
    s.turns.forEach((t, ti) => {
      const around = s.turns.slice(Math.max(0, ti - 2), ti + 3).map(x => x.line).join("\n");
      splitSentences(t.text).forEach((sentence, k) => {
        const id = `K-s${si + 1}-${ti + 1}-${k + 1}`;
        store.run("insert into knowledge(id, gist, summary, raw, source, status, author, verified_by, created_at) values(?, ?, ?, ?, ?, 'verified', 'ingest', 'ingest', ?)",
          id, `${when}${t.speaker ? `${t.speaker}: ` : ""}${sentence}`, `${when}${t.line}`, `${when}\n${around}`, `conversation session ${si + 1} turn ${ti + 1}`, now);
        store.run("insert into domain_knowledge(domain, knowledge) values(?, ?)", domain, id);
        n++;
      });
    });
  }));
  return n;
}
