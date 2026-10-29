import type { Context } from "@earendil-works/chord";
import { defineDoc, defineExtension, hook, ToolTask, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";

export type Role = "author" | "source_reviewer" | "gist_reviewer";
export const roles: Role[] = ["author", "source_reviewer", "gist_reviewer"];
export type AgentStatus = "initializing" | "active" | "draining" | "dormant" | "recovering" | "failed";
export type AgentRecord = {
  id: string; conversationId: string; name: string; role: string; capabilities: string[];
  status: AgentStatus; domainIds: string[]; goalIds: string[]; parentAgentId: string | null;
  createdAt: number; updatedAt: number; lastActiveAt: number | null; revision: number;
};
const transitions: Record<AgentStatus, AgentStatus[]> = {
  initializing: ["active", "recovering", "failed"], active: ["draining", "recovering", "failed"],
  draining: ["active", "dormant", "recovering", "failed"], dormant: ["recovering"],
  recovering: ["active", "draining", "dormant", "failed"], failed: ["recovering"],
};
export function transitionAgent(agent: AgentRecord, expectedRevision: number, status: AgentStatus, now: number) {
  if (agent.revision !== expectedRevision) throw new Error("Agent revision conflict");
  if (!transitions[agent.status].includes(status)) throw new Error("Invalid agent status transition");
  agent.status = status; agent.revision++; agent.updatedAt = now;
}
export const AgentDirectory = defineDoc<{ ids: Partial<Record<Role, number>>; agents?: AgentRecord[] }>({
  kind: "delm.agent-directory", version: 1, scope: "session",
  initial: () => ({ ids: {} }), checkpointWhen: () => false,
});

export function canClaimTask(directory: { ids: Partial<Record<Role, number>>; agents?: AgentRecord[] }, task: { role: Role; assignedAgentId?: string }, conversationId: number): boolean {
  const agent = directory.agents?.find(a => a.conversationId === String(conversationId));
  if (agent && agent.status !== "active") return false;
  if (!Object.values(directory.ids).includes(conversationId) && !agent?.capabilities.includes("task_management")) return false;
  return task.assignedAgentId ? agent?.id === task.assignedAgentId : directory.ids[task.role] === conversationId;
}

// Base roles retain their existing tool-specific authorization; dynamic agents use an explicit allowlist.
const dynamicTools: Record<string, string[]> = {
  research: ["memory_search", "memory_publish", "knowledge_search", "knowledge_unfold", "domain_list", "domain_inspect", "goal_list", "goal_inspect", "agent_list", "agent_inspect", "organization_status"],
  task_management: ["task_discover", "task_claim", "task_heartbeat", "task_release", "task_finish", "task_status", "agent_handoff", "agent_consolidate"],
};
const ownContextTools = ["context_read", "context_edit", "context_history", "context_restore", "context_checkpoint"];
export function canUseTool(directory: { ids: Partial<Record<Role, number>>; agents?: AgentRecord[] }, conversationId: number, tool: string): boolean {
  const agent = directory.agents?.find(a => a.conversationId === String(conversationId));
  if (!agent || !["active", "draining"].includes(agent.status)) return false;
  if (Object.values(directory.ids).includes(conversationId)) return true;
  if (ownContextTools.includes(tool)) return true;
  return agent.capabilities.some(capability => dynamicTools[capability]?.includes(tool));
}
export const AgentPermissionExtension = defineExtension({ name: "delm-agent-permissions", hooks: [hook(ToolTask, {
  beforeTool: async (call, api, context) => {
    const directory = await api.snapshot(AgentDirectory, context);
    if (!directory || !canUseTool(directory, api.conversationId, call.name)) return { block: "Agent is not authorized to use this tool" };
  },
})] });

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
      if (ids[role] !== undefined) throw new Error(`Registered conversation is missing or duplicated: ${role}`);
      const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
      ids[role] = conversation.id;
    }
    if (new Set(roles.map(role => ids[role])).size !== roles.length) throw new Error("Agent roles have duplicate conversation IDs");
    // Existing version-1 directories have only ids. Preserve those IDs and add records in place.
    directory.agents ??= [];
    for (const role of roles) {
      const id = `agent:base:${role}`, conversationId = String(ids[role]);
      const existing = directory.agents.find(agent => agent.id === id);
      if (existing && existing.conversationId !== conversationId) throw new Error(`Agent conversation changed: ${id}`);
      if (directory.agents.some(agent => agent.id !== id && agent.conversationId === conversationId)) throw new Error("Duplicate agent conversation");
      if (!existing) {
        const now = Date.now();
        directory.agents.push({ id, conversationId, name: role, role, capabilities: [], status: "active", domainIds: [], goalIds: [], parentAgentId: null, createdAt: now, updatedAt: now, lastActiveAt: null, revision: 0 });
      }
    }
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
