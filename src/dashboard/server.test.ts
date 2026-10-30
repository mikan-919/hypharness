import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, Store } from "../db.ts";

test("dashboard lists sessions read-only and refuses paths it did not discover", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hyph-dash-"));
  mkdirSync(join(dir, "run"));
  const store = new Store(join(dir, "run", "state.sqlite"));
  store.init("Dashboard check", "", defaultConfig);
  store.db.close();
  const port = 40000 + Math.floor(Math.random() * 20000);
  const server = Bun.spawn(["bun", join(import.meta.dir, "server.ts"), "--dir", dir, "--port", String(port)], { stdout: "pipe", stderr: "inherit", env: { ...process.env, NODE_ENV: "production" } });
  try {
    const reader = server.stdout.getReader();
    while (!new TextDecoder().decode((await reader.read()).value).includes("dashboard:"));
    const base = `http://127.0.0.1:${port}`;
    const sessions = await (await fetch(`${base}/api/sessions`)).json() as { id: string; purpose: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.purpose).toBe("Dashboard check");
    const overview = await (await fetch(`${base}/api/overview?s=${encodeURIComponent(sessions[0]!.id)}`)).json() as { agents: { id: string }[] };
    expect(overview.agents.map(a => a.id)).toEqual(["lead"]);
    expect((await fetch(`${base}/api/overview?s=${encodeURIComponent(join(dir, ".."))}`)).status).toBe(404);
    expect((await fetch(`${base}/api/agent?s=${encodeURIComponent(sessions[0]!.id)}&id=nobody`)).status).toBe(404);
  } finally {
    server.kill();
  }
});
