
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import { SharedMemory } from "../memory.ts";

const publish = defineTool({
  name: "memory_publish",
  description: "重要な発見や知識を共有記憶に保存する",
  parameters: Type.Object({
    content: Type.String({
      minLength: 1,
      maxLength: 4000,
    }),
  }),
  replay: "safe",

  execute: async ({ content }, api, context) => {
    const id = `${api.conversationId}:${api.callId}`;

    await api.commit(async (tx) => {
      const state = await tx.doc(SharedMemory);

      // 中断後の再実行による重複を防ぐ
      if (state.memories.some((m) => m.id === id)) {
        return;
      }

      state.memories.push({
        id,
        author: String(api.conversationId),
        content,
        createdAt: api.now(),
      });
    }, context);

    return {
      output: [
        { type: "text", text: `Saved: ${id}` },
      ],
    };
  },
});

const search = defineTool({
  name: "memory_search",
  description: "共有記憶からキーワードに関連する情報を探す",
  parameters: Type.Object({
    query: Type.String({ minLength: 1 }),
  }),

  execute: async ({ query }, api, context) => {
    const state = await api.snapshot(
      SharedMemory,
      context,
    );

    const results = (state?.memories ?? [])
      .filter((m) =>
        m.content.toLowerCase().includes(
          query.toLowerCase(),
        ),
      )
      .slice(0, 10);

    return {
      output: [{
        type: "text",
        text: JSON.stringify(results),
      }],
    };
  },
});

export const MemoryExtension = defineExtension({
  name: "delm-memory",
  tools: [publish, search],
});
