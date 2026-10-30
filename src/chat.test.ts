import { expect, test } from "bun:test";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { history, openChat, reply, WINDOW } from "./chat.ts";

function llmWith(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(responses);
  return { models, model: faux.getModel() };
}
const textOf = (m: Message) => typeof m.content === "string" ? m.content : m.content.map(b => (b as { text?: string }).text ?? "").join("");

test("the front chat keeps only the window in context and finds older messages in memory", async () => {
  const store = openChat(":memory:");
  const seen: string[] = [];
  const echo = (ctx: { messages: Message[] }) => { seen.push(textOf(ctx.messages.find(m => m.role === "user")!)); return fauxAssistantMessage("ok"); };
  const llm = llmWith(Array(WINDOW).fill(echo));
  await reply(llm, store, "My cat is called Mochi. She is three.");
  for (let i = 1; i < WINDOW / 2; i++) await reply(llm, store, `small talk ${i}`);
  expect(store.get<{ n: number }>("select count(*) n from knowledge")!.n).toBe(0);

  // The next message pushes the first message out of the window: it moves into memory, sentence by sentence.
  let first = "";
  const recall = (ctx: { messages: Message[] }) => {
    first = textOf(ctx.messages.find(m => m.role === "user")!);
    return ctx.messages.some(m => m.role === "toolResult")
      ? fauxAssistantMessage("Mochi")
      : fauxAssistantMessage([fauxToolCall("knowledge_search", { query: "cat" })], { stopReason: "toolUse" });
  };
  const llm2 = llmWith([recall, recall]);
  const r = await reply(llm2, store, "What is my cat's name?");
  expect(r).toMatchObject({ reply: "Mochi", calls: 2, lookups: 1, remembered: 1 });
  expect(first).not.toContain("Mochi");
  expect(first).toContain("small talk 2");
  expect(store.all<{ gist: string }>("select gist from knowledge order by id").map(k => k.gist.replace(/^\[[^\]]+\] /, ""))).toEqual([
    "User: My cat is called Mochi.", "User: She is three.",
  ]);
  expect(history(store).map(m => m.remembered)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
  expect(seen[0]).toStartWith("New message from the user");
});
