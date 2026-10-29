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

To type check and test without calling an external model:

```bash
bunx tsrs --noEmit
bun test
```

This project was created using `bun init` in bun v1.4.4. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
