import type { Context } from "@earendil-works/chord";
import { defineDoc, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";

export type Role = "author" | "source_reviewer" | "gist_reviewer";
export const roles: Role[] = ["author", "source_reviewer", "gist_reviewer"];
export const AgentDirectory = defineDoc<{ ids: Partial<Record<Role, number>> }>({
  kind: "delm.agent-directory", version: 1, scope: "session",
  initial: () => ({ ids: {} }), checkpointWhen: () => false,
});

export async function restoreAgents(harness: Harness, context: Context): Promise<Record<Role, Conversation>> {
  const root = await harness.root(context);
  await harness.commit(async (tx) => {
    const directory = await tx.doc(AgentDirectory);
    const ids = directory.ids;
    if (ids.author !== undefined && ids.author !== root.id) throw new Error("Author registration conflicts with root");
    ids.author = root.id;
    const reviewerRoles = ["source_reviewer", "gist_reviewer"] as const;
    const valid = await Promise.all(reviewerRoles.map(async role => ids[role] !== undefined && !!(await tx.conversation(ids[role] as ConversationId))));
    if (ids.source_reviewer === root.id) valid[0] = false;
    if (ids.gist_reviewer === root.id || (valid[0] && ids.gist_reviewer === ids.source_reviewer)) valid[1] = false;
    for (const [index, role] of reviewerRoles.entries()) {
      if (valid[index]) continue;
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      ids[role] = conversation.id;
    }
    if (new Set(roles.map(role => ids[role])).size !== roles.length) throw new Error("Agent roles have duplicate conversation IDs");
  }, context);
  const directory = await harness.snapshot(AgentDirectory, context);
  if (!directory) throw new Error("Agent directory is missing");
  const result = {} as Record<Role, Conversation>;
  for (const role of roles) {
    const agent = await harness.conversation(directory.ids[role] as ConversationId, context);
    if (!agent) throw new Error(`Missing agent: ${role}`);
    result[role] = agent;
  }
  return result;
}
