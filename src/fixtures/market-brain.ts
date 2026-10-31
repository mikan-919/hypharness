import { fauxAssistantMessage, fauxToolCall, type AssistantMessage, type Message } from "@earendil-works/pi-ai";

export const call = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

export const openingOf = (messages: Message[]) => {
  const first = messages.find(m => m.role === "user")!.content as string | { text?: string }[];
  return typeof first === "string" ? first : first.map(b => b.text ?? "").join("");
};

// A scripted market organization for tests: lead splits G0 into the given subgoals and submits each goal once it is
// idle, the investors fund every subgoal, critics, evaluators and verifiers pass, and each work task goes to `work`.
export function marketBrain(subgoals: string[], work: (opening: string, used: string[], messages: Message[]) => AssistantMessage, budget = 20) {
  let split = false;
  return (ctx: { messages: Message[] }) => {
    const opening = openingOf(ctx.messages), used = ctx.messages.filter(m => m.role === "toolResult").map(m => m.toolName);
    const kind = opening.match(/## Current task \S+ \((\w+)/)![1];
    if (kind === "steer") {
      const goal = opening.match(/Goal (\S+) has no pending work/)![1]!;
      if (goal === "G0" && !split) {
        const made = used.filter(u => u === "goal_create").length;
        if (made < subgoals.length) return call("goal_create", { parent: "G0", description: subgoals[made]! });
        split = true;
        return call("task_finish", { result: `split into ${subgoals.length} subgoals` });
      }
      if (!used.includes("goal_complete")) return call("goal_complete", { id: goal, deliverable: "the files in the workspace" });
      return call("task_finish", { result: "submitted" });
    }
    if (kind === "invest") return call("goal_fund", { goal: opening.match(/Goal (G-\w+): /)![1]!, budget, rationale: "a small task" });
    if (kind === "work") return work(opening, used, ctx.messages);
    return call("task_finish", { result: "checked the artifacts", verdict: "pass" }); // critique, judge, verify
  };
}
