# hypharness

To install dependencies:

```bash
bun install
```

Run with an existing `auth.json` and a source text to submit for review:

```bash
bun run start 'The source text to review.'
```

Run without an argument to resume work in `session.sqlite`. The scheduler stops when no task can be claimed, or after 20 rounds. A claimed task becomes available again after its lease expires. Each agent run has a two-minute timeout; generation requests are capped at 200 per process.

To initialize an immutable global goal and queue subgoal planning, run `bun run start --goal 'Your goal'`. A later run can omit `--goal` to resume; supplying a different goal for the same session is rejected. Domains hold references to knowledge, not copies. Split, merge, and transfer proposals require an independent review and an atomic apply. Cross-domain hypotheses are recorded as unverified tasks. Analysis is triggered by accumulated knowledge and cross-domain signals; discovery and reorganization have persistent limits.

Each agent has a separate persistent context. `context_read` reads bounded portions of another agent's context; context edits and restores affect only the caller. `contexts/<conversation-id>/LIVE_CTX.md` is a generated mirror, not an input file, and is rebuilt on startup. The default context budget is 32768 estimated tokens, with 4096 reserved for output and 4096 for recent history. Set `CLM_MAX_TOKENS` for newly initialized contexts; existing contexts retain their stored budget. Requests over budget fail instead of silently dropping required history. A checkpoint replaces history only when the recorded entry boundary and exact message prefix can be verified; otherwise the history remains intact.

To type check and test without calling an external model:

```bash
bunx tsrs --noEmit
bun test
```

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
