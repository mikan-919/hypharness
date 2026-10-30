import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, Store } from "../db.ts";

// The server runs in a directory without auth.json, so harness runs it starts exit before any model call.
async function serve(dir: string) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts"), "--dir", ".hyph", "--port", String(port)], { cwd: dir, stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  const reader = proc.stdout.getReader();
  while (!new TextDecoder().decode((await reader.read()).value).includes("dashboard:"));
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = { origin: base, "content-type": "application/json" }) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { proc, base, post };
}

test("dashboard lists sessions read-only and refuses paths it did not discover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-dash-"));
  mkdirSync(join(dir, ".hyph", "run"), { recursive: true });
  const store = new Store(join(dir, ".hyph", "run", "state.sqlite"));
  store.init("Dashboard check", "", defaultConfig);
  store.db.close();
  const { proc, base } = await serve(dir);
  try {
    const sessions = await (await fetch(`${base}/api/sessions`)).json() as { id: string; purpose: string }[];
    expect(sessions.map(s => [s.id, s.purpose])).toEqual([[".hyph/run", "Dashboard check"]]);
    const overview = await (await fetch(`${base}/api/overview?s=.hyph/run`)).json() as { agents: { id: string }[] };
    expect(overview.agents.map(a => a.id)).toEqual(["lead"]);
    expect((await fetch(`${base}/api/overview?s=..`)).status).toBe(404);
    expect((await fetch(`${base}/api/file?s=.hyph/run&path=../state.sqlite`)).status).toBe(400);
  } finally {
    proc.kill();
  }
});

test("runs start only from the dashboard's own origin, and their output and exit are reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-runs-"));
  const { proc, base, post } = await serve(dir);
  try {
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { origin: "http://evil.example", "content-type": "application/json" })).status).toBe(403);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p" }, { origin: base, "content-type": "text/plain" })).status).toBe(415);
    expect((await post("/api/runs", { name: "../x", kind: "run", purpose: "p" })).status).toBe(400);
    expect((await post("/api/runs", { name: "x", kind: "run", purpose: "p", calls: -1 })).status).toBe(400);

    const started = await (await post("/api/runs", { name: "first", kind: "run", purpose: "Write a file", mode: "single", calls: 5 })).json() as { dir: string; args: string[] };
    expect(started.dir).toBe(".hyph/first");
    expect(started.args).toEqual(["Write a file", "--dir", ".hyph/first", "--calls", "5", "--mode", "single"]);
    let out: { exitCode: number | null; lines: string[] };
    do {
      await Bun.sleep(100);
      out = await (await fetch(`${base}/api/output?dir=.hyph/first`)).json() as typeof out;
    } while (out.exitCode === null);
    expect(out.exitCode).not.toBe(0);
    expect(out.lines.join("\n")).toContain("auth.json");

    // The state was created before the model failed, so the run can be resumed but not started again.
    expect((await post("/api/runs", { name: "first", kind: "run", purpose: "Write a file" })).status).toBe(400);
    const resumed = await post("/api/runs/resume", { session: ".hyph/first", calls: 10, allowShell: true });
    expect(((await resumed.json()) as { args: string[] }).args).toEqual(["--dir", ".hyph/first", "--calls", "10", "--allow-shell"]);
    expect((await post("/api/runs/resume", { session: ".hyph/none" })).status).toBe(400);
  } finally {
    proc.kill();
  }
});

test("output of earlier runs stays readable from the session's run.log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-log-"));
  mkdirSync(join(dir, ".hyph", "old"), { recursive: true });
  const store = new Store(join(dir, ".hyph", "old", "state.sqlite"));
  store.init("Old run", "", defaultConfig);
  store.db.close();
  await Bun.write(join(dir, ".hyph", "old", "run.log"), "first\nsecond\n");
  const { proc, base } = await serve(dir);
  try {
    expect(await (await fetch(`${base}/api/runlog?s=.hyph/old`)).json()).toEqual({ lines: ["first", "second"] });
  } finally {
    proc.kill();
  }
});
